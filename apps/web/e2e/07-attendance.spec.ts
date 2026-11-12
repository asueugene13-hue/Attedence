import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import { type APIRequestContext, expect, test } from '@playwright/test';
import pg from 'pg';
import { activationToken, PASSWORD } from './helpers';

// Phase 5 screens, end to end on the real clock: the lecturer starts a class and opens attendance,
// shows the code for a projector, watches a student's check-in arrive live on the roster, approves
// it, and closes attendance. Uses the section, lecturer, room, beacon and students from 02, 03 and 06.
//
// Setup note: the earlier journeys' classes are in 2030, and attendance can only open close to a
// class's time, so one obviously fake class is inserted for *now* (and student 2 enrolled) straight
// into the e2e database. Everything after that goes through the real API and screens.
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3100/api/v1';
const LECTURER = 'e2e.lecturer@example.test';
const STUDENT = 'e2e.student2@example.test';

async function activate(request: APIRequestContext, email: string) {
  const token = await activationToken(request, email);
  await request.post(`${API}/auth/activate`, { data: { token, password: PASSWORD } });
}

async function apiToken(request: APIRequestContext, identifier: string) {
  const res = await request.post(`${API}/auth/login`, {
    data: { identifier, password: PASSWORD, client: 'MOBILE' },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).accessToken as string;
}

/** A class starting five minutes ago, for the e2e section, lecturer and room; student 2 enrolled. */
async function classForNow(): Promise<string> {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
    const lecturer = await one(
      `SELECT l.id FROM lecturer_profiles l JOIN users u ON u.id = l.user_id WHERE u.email = $1`,
      [LECTURER],
    );
    const section = await one(
      `SELECT s.id, s.offering_id FROM course_sections s JOIN course_offerings o ON o.id = s.offering_id
       JOIN courses c ON c.id = o.course_id WHERE c.code = 'TST101' AND s.code = 'A'`,
    );
    const room = await one(`SELECT id FROM classrooms WHERE code = 'E2E-R1'`);
    const student = await one(
      `SELECT p.id FROM student_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = $1`,
      [STUDENT],
    );
    const admin = await one(`SELECT id FROM users WHERE email = 'e2e.admin@example.test'`);
    await db.query(
      `INSERT INTO course_enrollments (id, student_id, offering_id, section_id, enrolled_at, created_by_id, updated_at)
       SELECT gen_random_uuid(), $1, $2, $3, now() - interval '1 day', $4, now()
       WHERE NOT EXISTS (SELECT 1 FROM course_enrollments WHERE student_id = $1 AND offering_id = $2 AND status = 'ENROLLED')`,
      [student.id, section.offering_id, section.id, admin.id],
    );
    const cls = await one(
      `INSERT INTO class_sessions (id, kind, lecturer_id, classroom_id, scheduled_start, scheduled_end, updated_at)
       VALUES (gen_random_uuid(), 'MAKEUP', $1, $2, now() - interval '5 minutes', now() + interval '60 minutes', now())
       RETURNING id`,
      [lecturer.id, room.id],
    );
    await db.query(`INSERT INTO class_session_sections (class_session_id, section_id) VALUES ($1, $2)`, [
      cls.id,
      section.id,
    ]);
    return cls.id as string;
  } finally {
    await db.end();
  }
}

/** The student's phone: registered, then a signed check-in, as the app sends it. */
async function studentChecksIn(request: APIRequestContext, qrToken: string, rssi: number) {
  const token = await apiToken(request, STUDENT);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const device = await request.post(`${API}/me/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      installationId: randomUUID(),
      platform: 'ANDROID',
      publicKey: publicKey.export({ format: 'jwk' }).x,
    },
  });
  const deviceId = (await device.json()).id as string;
  const body = JSON.stringify({
    qrToken,
    bluetooth: 'ON',
    readings: [{ identifier: 'e2e00000000000000000000000000001', rssi }],
    location: null,
  });
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll('-', '');
  const payload = deviceSigningPayload({
    method: 'POST',
    path: '/api/v1/check-ins',
    timestamp,
    nonce,
    bodySha256Hex: createHash('sha256').update(body).digest('hex'),
  });
  const res = await request.post(`${API}/check-ins`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      [DEVICE_HEADERS.device]: deviceId,
      [DEVICE_HEADERS.timestamp]: timestamp,
      [DEVICE_HEADERS.nonce]: nonce,
      [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), privateKey).toString('base64url'),
    },
    data: body,
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('a lecturer runs attendance: opens it, shows the code, sees a check-in live, approves it, closes it', async ({
  page,
  context,
  request,
}) => {
  await activate(request, LECTURER);
  await activate(request, STUDENT);
  const classId = await classForNow();

  // 1. The lecturer signs in and starts the class with attendance, from its page.
  await page.goto('/login');
  await page.getByLabel('Email').fill(LECTURER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto(`/classes/${classId}`);
  await page.getByRole('button', { name: 'Start class and open attendance' }).click();
  const open = page.getByRole('dialog', { name: 'Start class and open attendance' });
  await open.getByRole('button', { name: 'Start and open' }).click();
  await expect(open).toBeHidden();
  const panel = page.getByRole('region', { name: 'Attendance' });
  await expect(panel.getByText('Open', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/18-attendance-open.png', fullPage: true });

  // 2. The code for a projector, full screen, changing on its own.
  const roster = panel.getByRole('link', { name: 'Live roster' });
  const attendanceId = (await roster.getAttribute('href'))!.split('/').pop()!;
  const projector = await context.newPage();
  await projector.goto(`/attendance-code/${attendanceId}`);
  await expect(projector.getByRole('img', { name: /Attendance code/ })).toBeVisible();
  await projector.screenshot({ path: 'test-results/screens/19-attendance-code.png' });

  // 3. The live roster lists the enrolled student, not checked in yet.
  await roster.click();
  await expect(page.getByRole('heading', { name: 'Live roster' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Live');
  const row = page.getByRole('row').filter({ hasText: 'E2E Student Two' });
  await expect(row).toContainText('Not checked in');

  // 4. The student checks in with a weak beacon signal: it waits for the lecturer, and the roster
  //    shows it without reloading the page.
  const lecturerToken = await apiToken(request, LECTURER);
  const qr = await request.get(`${API}/attendance-sessions/${attendanceId}/qr`, {
    headers: { Authorization: `Bearer ${lecturerToken}` },
  });
  const result = await studentChecksIn(request, (await qr.json()).token, -90);
  expect(result).toMatchObject({ outcome: 'PENDING_VERIFICATION', recordStatus: 'PENDING' });
  await expect(row).toContainText('Waiting for you', { timeout: 5000 });
  await expect(row).toContainText('Beacon weak');
  await page.screenshot({ path: 'test-results/screens/20-roster-waiting.png', fullPage: true });

  // 5. The lecturer approves it.
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Present');

  // 6. And closes attendance from the class page; the projector page then says it is closed.
  await page.getByRole('link', { name: 'Back to the class' }).click();
  await page
    .getByRole('region', { name: 'Attendance' })
    .getByRole('button', { name: 'Close attendance' })
    .click();
  await expect(
    page.getByRole('region', { name: 'Attendance' }).getByText('Closed', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/21-attendance-closed.png', fullPage: true });
  await projector.reload();
  await expect(projector.getByText('Attendance is closed for this class.')).toBeVisible();
});
