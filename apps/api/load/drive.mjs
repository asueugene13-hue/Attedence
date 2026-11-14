// Load test driver (Phase 8 step 4). Sends check-ins to the production rehearsal exactly as phones do
// (signed by each phone's key, through the HTTPS proxy), while the lecturer's live roster is connected and
// an administrator uses the dashboard, analytics and a report file at the same time.
//
//   node apps/api/load/drive.mjs <load-run.json> burst     all phones at the same moment
//   node apps/api/load/drive.mjs <load-run.json> minute    phones spread at random over 60 seconds
//
// Prints one JSON summary. See load/README.md. REHEARSAL ONLY: it talks to https://localhost:8443 by default
// and accepts the rehearsal's local certificate.
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import { io } from 'socket.io-client';

const [file, mode = 'burst'] = process.argv.slice(2);
if (!file || !['burst', 'minute'].includes(mode)) {
  console.error('Usage: node apps/api/load/drive.mjs <load-run.json> burst|minute');
  process.exit(1);
}
const BASE = process.env.LOAD_BASE_URL ?? 'https://localhost:8443';
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 100);
const run = JSON.parse(readFileSync(file, 'utf8'));
// Phones on campus reach the proxy over many connections; the proxy keeps its own pool to the API.
const agent = new Agent({ keepAlive: true, maxSockets: CONNECTIONS, rejectUnauthorized: false });

/** One HTTPS request; resolves with status, parsed body and time taken (never rejects). */
function call(method, path, { token, body, headers = {} } = {}) {
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const req = httpsRequest(
      `${BASE}${path}`,
      {
        method,
        agent,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(text ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // not JSON (for example a proxy error page); kept as text
          }
          resolve({ status: res.statusCode, body: parsed, ms: performance.now() - t0 });
        });
      },
    );
    req.on('error', (e) =>
      resolve({ status: `ERR ${e.code ?? e.message}`, body: null, ms: performance.now() - t0 }),
    );
    req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
    if (text) req.write(text);
    req.end();
  });
}

const keys = new Map(run.students.map((s) => [s.number, createPrivateKey(s.privateKeyPem)]));
function checkIn(student, qrToken, idempotencyKey) {
  const body = JSON.stringify({
    qrToken,
    bluetooth: 'ON',
    readings: [{ identifier: run.beaconIdentifier, rssi: -62 }],
    location: { latitude: run.site.lat + 30 / 111_195, longitude: run.site.lng, accuracyM: 15 },
  });
  const path = '/api/v1/check-ins';
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll('-', '');
  const payload = deviceSigningPayload({
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodySha256Hex: createHash('sha256').update(body).digest('hex'),
  });
  return call('POST', path, {
    token: student.token,
    body,
    headers: {
      'Idempotency-Key': idempotencyKey,
      [DEVICE_HEADERS.device]: student.deviceId,
      [DEVICE_HEADERS.timestamp]: timestamp,
      [DEVICE_HEADERS.nonce]: nonce,
      [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), keys.get(student.number)).toString(
        'base64url',
      ),
    },
  });
}

const pct = (sorted, p) =>
  sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)])
    : null;
function stats(list) {
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const r of list) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return {
    requests: list.length,
    statuses,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    max: ms.length ? Math.round(ms.at(-1)) : null,
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. The lecturer opens attendance (and starts the class), then keeps the live roster open.
const opened = await call('POST', `/api/v1/class-sessions/${run.classSessionId}/attendance/open`, {
  token: run.lecturerToken,
  body: { startClass: true },
});
if (opened.status !== 201)
  throw new Error(`could not open attendance: ${opened.status} ${JSON.stringify(opened.body)}`);
const attendanceId = opened.body.id;

const seen = new Set();
const live = io(`${BASE}/attendance`, {
  path: '/api/v1/live',
  addTrailingSlash: false,
  transports: ['websocket'],
  auth: { token: run.lecturerToken },
  rejectUnauthorized: false,
  forceNew: true,
});
const drops = [];
live.on('disconnect', (reason) => drops.push(reason));
await new Promise((resolve, reject) => {
  live.on('connect', resolve);
  live.on('connect_error', reject);
});
const joined = await live.timeout(10_000).emitWithAck('join', { attendanceSessionId: attendanceId });
if (!joined.ok) throw new Error('could not join the live roster');
live.on('attendance', (e) => {
  if (e.type === 'record.updated' && e.data?.studentId) seen.add(e.data.studentId);
});

// The lecturer's screen: the rotating code, fetched every 5 s as the screen does.
let qr = (await call('GET', `/api/v1/attendance-sessions/${attendanceId}/qr`, { token: run.lecturerToken }))
  .body.token;
const qrCalls = [];
const qrTimer = setInterval(async () => {
  const r = await call('GET', `/api/v1/attendance-sessions/${attendanceId}/qr`, { token: run.lecturerToken });
  qrCalls.push(r);
  if (r.status === 200) qr = r.body.token;
}, 5_000);

// 2. At the same time, an administrator: dashboard and roster every 2 s, analytics every 5 s, one report file.
const background = { dashboard: [], roster: [], analytics: [] };
let stopBackground = false;
const backgroundLoop = (async () => {
  let tick = 0;
  while (!stopBackground) {
    const jobs = [
      call('GET', '/api/v1/me/admin-dashboard', { token: run.adminToken }).then((r) =>
        background.dashboard.push(r),
      ),
      call('GET', `/api/v1/attendance-sessions/${attendanceId}/roster`, { token: run.lecturerToken }).then(
        (r) => background.roster.push(r),
      ),
    ];
    if (tick % 5 === 0)
      jobs.push(
        call('GET', `/api/v1/analytics/attendance?semesterId=${run.semesterId}&groupBy=course`, {
          token: run.adminToken,
        }).then((r) => background.analytics.push(r)),
      );
    await Promise.all(jobs);
    tick++;
    await sleep(2_000);
  }
})();
const exportAsked = await call('POST', '/api/v1/reports/exports', {
  token: run.adminToken,
  body: {
    reportType: 'ATTENDANCE_ANALYTICS',
    format: 'XLSX',
    params: { semesterId: run.semesterId, groupBy: 'course' },
  },
});

// 3. The check-ins.
const idempotency = new Map(run.students.map((s) => [s.number, randomUUID()]));
const started = performance.now();
const answers = await Promise.all(
  run.students.map(async (s) => {
    if (mode === 'minute') await sleep(Math.random() * 60_000);
    // As the app does (lib/attendance.ts submitCheckIn): after a gateway error (502/503/504) send again
    // every 5 s, freshly signed, with the same Idempotency-Key and the code scanned. Time is from the scan.
    const code = qr;
    const t0 = performance.now();
    let r = await checkIn(s, code, idempotency.get(s.number));
    let resent = 0;
    while ([502, 503, 504].includes(r.status) && performance.now() - t0 < 120_000) {
      await sleep(5_000);
      resent++;
      r = await checkIn(s, code, idempotency.get(s.number));
    }
    return { ...r, ms: performance.now() - t0, resent, sentAt: performance.now() - started };
  }),
);
const wallMs = performance.now() - started;

// 4. Every phone retries with the same key (a flaky network): same answer, nothing new stored.
const retries = await Promise.all(run.students.map((s) => checkIn(s, qr, idempotency.get(s.number))));
const sameAttempt = retries.filter(
  (r, i) => r.status === 200 && r.body.attemptId === answers[i].body?.attemptId,
).length;

// 5. Let the live roster catch up, then stop the background load and look at the results.
const liveDeadline = Date.now() + 15_000;
while (seen.size < run.students.length && Date.now() < liveDeadline) await sleep(200);
stopBackground = true;
clearInterval(qrTimer);
await backgroundLoop;
live.off('disconnect');
live.disconnect();

let exportStatus = null;
if (exportAsked.status === 201) {
  for (let i = 0; i < 30; i++) {
    const r = await call('GET', `/api/v1/reports/exports/${exportAsked.body.id}`, { token: run.adminToken });
    exportStatus = r.body?.status;
    if (exportStatus === 'READY' || exportStatus === 'FAILED') break;
    await sleep(1_000);
  }
}
const roster = await call('GET', `/api/v1/attendance-sessions/${attendanceId}/roster`, {
  token: run.lecturerToken,
});

const outcomes = {};
for (const a of answers) {
  const k =
    a.status === 200
      ? `${a.body.outcome}/${a.body.recordStatus}`
      : `HTTP ${a.status} ${a.body?.code ?? ''}`.trim();
  outcomes[k] = (outcomes[k] ?? 0) + 1;
}
console.warn(
  JSON.stringify(
    {
      mode,
      students: run.students.length,
      connections: CONNECTIONS,
      checkIns: {
        ...stats(answers),
        wallSeconds: Math.round(wallMs / 100) / 10,
        outcomes,
        sentAgainAfterGatewayError: answers.filter((a) => a.resent > 0).length,
      },
      retries: { ...stats(retries), sameAttempt },
      liveRoster: { studentsSeen: seen.size, drops },
      rosterCounts: roster.body?.counts ?? roster.status,
      lecturerCode: stats(qrCalls),
      adminDashboard: stats(background.dashboard),
      rosterReloads: stats(background.roster),
      analytics: stats(background.analytics),
      reportFile: { asked: exportAsked.status, finalStatus: exportStatus },
    },
    null,
    2,
  ),
);
agent.destroy();
