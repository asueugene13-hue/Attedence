import { randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { buildClass, inRoom, signedCheckIn, type Student } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// Phase 5 exit criterion and TESTING.md scenario 25: 500 check-ins arriving within one minute.
// The hardest form of it: all 500 students of one class send their check-in at the same moment,
// each from their own signed phone, over real HTTP to a listening API, while the lecturer's live
// roster is connected. Then every phone retries with the same idempotency key (a flaky network).
// In production phones reach the API through a reverse proxy, which keeps a pool of connections open
// to it; here the 500 requests are all sent at once over a pool of 100 kept-alive connections, the
// same shape. (Opening 500 brand-new connections at once is refused by Windows itself after about 200
// waiting, whatever the API asks for, so that would measure the test computer, not AttendSure.)
// Obviously fake data: 500 made-up students (99000001–99000500) in a made-up class.
const STUDENTS = 500;
const CONNECTIONS = 100;
const proxyPool = new Agent({ keepAlive: true, maxSockets: CONNECTIONS });
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let baseUrl: string;
let c: Awaited<ReturnType<typeof buildClass>>;
let attendanceId: string;
let live: Socket | undefined;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
  // Real connections to the listening server, as phones make them.
  http = request(baseUrl);
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: STUDENTS });
  clock.set('2030-08-20T10:00:00Z');
  attendanceId = (
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ startClass: true })
      .expect(201)
  ).body.id;
}, 300_000);

afterAll(async () => {
  live?.disconnect();
  proxyPool.destroy();
  await app?.close();
}, 60_000);

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe('scenario 25: 500 check-ins at once', () => {
  it('confirms every student exactly once, within the minute, and the live roster sees each one', async () => {
    // The lecturer's live roster, as the dashboard connects it.
    live = io(`${baseUrl}/attendance`, {
      auth: { token: c.lecturer.token },
      path: '/api/v1/live',
      addTrailingSlash: false,
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      live!.on('connect', () => resolve());
      live!.on('connect_error', reject);
    });
    const joined = (await live.timeout(5000).emitWithAck('join', { attendanceSessionId: attendanceId })) as {
      ok: boolean;
      seq: number;
    };
    expect(joined.ok).toBe(true);
    const seen = new Set<number>();
    const studentsSeen = new Set<string>();
    live.on('attendance', (e: { seq: number; type: string; data: { studentId?: string } }) => {
      if (e.type !== 'record.updated') return;
      seen.add(e.seq);
      if (e.data.studentId) studentsSeen.add(e.data.studentId);
    });

    clock.set('2030-08-20T10:02:00Z');
    const token = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)
    ).body.token as string;
    const keys = new Map<Student, string>(c.students.map((s) => [s, randomUUID()]));

    // Wave 1: every student at the same moment.
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const latencies: number[] = [];
    const answers = await Promise.all(
      c.students.map(async (s) => {
        const t0 = performance.now();
        const res = await signedCheckIn(http, clock, s, inRoom(token), keys.get(s))
          .agent(proxyPool)
          .catch((e: NodeJS.ErrnoException) => ({ status: `ERR ${e.code ?? e.message}`, body: {} }) as never);
        if (res.status === 200) latencies.push(performance.now() - t0);
        return res as Awaited<ReturnType<typeof signedCheckIn>>;
      }),
    );
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
    latencies.sort((a, b) => a - b);

    const statuses = new Map<number | string, number>();
    for (const r of answers) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    const failures = answers
      .filter((r) => r.status !== 200)
      .slice(0, 3)
      .map((r) => r.body);
    process.stdout.write(
      `[load] ${STUDENTS} check-ins at once over ${CONNECTIONS} connections: ${Math.round(wallMs)} ms in all; ` +
        `per confirmed check-in p50 ${Math.round(percentile(latencies, 50))} ms, p95 ${Math.round(percentile(latencies, 95))} ms, ` +
        `max ${Math.round(latencies.at(-1)!)} ms; processor ${cpuMs} ms (API and test phones share one process); statuses ${JSON.stringify(Object.fromEntries(statuses))}` +
        (failures.length ? `; first failures ${JSON.stringify(failures)}` : '') +
        '\n',
    );

    expect(Object.fromEntries(statuses)).toEqual({ 200: STUDENTS });
    expect(answers.every((r) => r.body.outcome === 'VERIFIED' && r.body.recordStatus === 'PRESENT')).toBe(
      true,
    );
    expect(wallMs).toBeLessThan(60_000);

    // Wave 2: every phone retries with the same idempotency key. Same answer, nothing new stored.
    const retries = await Promise.all(
      c.students.map((s) => signedCheckIn(http, clock, s, inRoom(token), keys.get(s)).agent(proxyPool)),
    );
    expect(retries.every((r) => r.status === 200)).toBe(true);
    expect(retries.map((r) => r.body.attemptId)).toEqual(answers.map((r) => r.body.attemptId));

    // The database: one record and one attempt per student, all present.
    expect(await prisma.attendanceRecord.count({ where: { attendanceSessionId: attendanceId } })).toBe(
      STUDENTS,
    );
    expect(
      await prisma.attendanceRecord.count({
        where: { attendanceSessionId: attendanceId, status: 'PRESENT' },
      }),
    ).toBe(STUDENTS);
    expect(await prisma.attendanceAttempt.count({ where: { attendanceSessionId: attendanceId } })).toBe(
      STUDENTS,
    );

    // The roster the lecturer reloads agrees.
    const roster = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/roster`).set(c.lecturer.auth).expect(200)
    ).body;
    expect(roster.counts.PRESENT).toBe(STUDENTS);

    // The live roster heard about every student, each event numbered once with no gaps.
    await expect.poll(() => studentsSeen.size, { timeout: 10_000, interval: 100 }).toBe(STUDENTS);
    const seqs = [...seen].sort((a, b) => a - b);
    expect(seqs.length).toBeGreaterThanOrEqual(STUDENTS);
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length);
  }, 180_000);
});
