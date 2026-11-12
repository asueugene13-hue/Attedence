import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import {
  buildClass,
  inRoom,
  newPhone,
  registerPhone,
  signedCheckIn,
  silent,
  type Student,
} from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// The live roster and lecturer decisions (Phase 5 step 3), and TESTING.md scenario 22 (the
// lecturer's device crashes). Real HTTP and a real Socket.IO connection; obviously fake data.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (hhmm: string) => clock.set(`2030-08-20T${hhmm}:00Z`);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let baseUrl: string;
let c: Awaited<ReturnType<typeof buildClass>>;
let attendanceId: string;
const sockets: Socket[] = [];

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
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

beforeEach(async () => {
  at('09:58');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 4 });
  attendanceId = (
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({})
      .expect(201)
  ).body.id;
});

const qr = async () =>
  (await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)).body
    .token as string;
const checkIn = async (s: Student, body: (token: string) => object = inRoom) =>
  (await signedCheckIn(http, clock, s, body(await qr())).expect(200)).body;
const roster = async (auth = c.lecturer.auth) =>
  (await http.get(`/api/v1/attendance-sessions/${attendanceId}/roster`).set(auth).expect(200)).body;
const line = async (s: Student) =>
  (await roster()).students.find((x: { studentId: string }) => x.studentId === s.profileId);

/** A live connection, as the lecturer's screen makes it. */
function connect(token: string): Promise<Socket> {
  const socket = io(`${baseUrl}/attendance`, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const join = (socket: Socket, id = attendanceId) =>
  socket.timeout(5000).emitWithAck('join', { attendanceSessionId: id }) as Promise<{
    ok: boolean;
    seq?: number;
    code?: string;
  }>;
function nextEvent(socket: Socket, type: string) {
  return new Promise<{ seq: number; type: string; data: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} event`)), 5000);
    const handler = (e: { seq: number; type: string; data: Record<string, unknown> }) => {
      if (e.type !== type) return;
      clearTimeout(timer);
      socket.off('attendance', handler);
      resolve(e);
    };
    socket.on('attendance', handler);
  });
}

describe('the roster', () => {
  it('lists every eligible student, who has checked in and with what evidence', async () => {
    let r = await roster();
    expect(r.counts).toMatchObject({ enrolled: 4, notCheckedIn: 4 });
    expect(r.students).toHaveLength(4);
    expect(r.students[0]).toMatchObject({ status: null, attempts: 0, lastAttempt: null });
    at('10:01');
    await checkIn(c.students[0]!);
    r = await roster();
    expect(r.counts).toMatchObject({ enrolled: 4, notCheckedIn: 3, PRESENT: 1 });
    expect(await line(c.students[0]!)).toMatchObject({
      status: 'PRESENT',
      source: 'CHECK_IN',
      attempts: 1,
      lastAttempt: { outcome: 'VERIFIED', evidence: { ble: 'STRONG', gps: 'INSIDE', device: 'TRUSTED' } },
    });
    expect(r.seq).toBeGreaterThan(0);
  });

  it('only the class’s lecturer and administrators in scope can see it', async () => {
    await http
      .get(`/api/v1/attendance-sessions/${attendanceId}/roster`)
      .set(c.otherLecturer.auth)
      .expect(403);
    await http.get(`/api/v1/attendance-sessions/${attendanceId}/roster`).set(c.students[0]!.auth).expect(403);
    await roster(c.admin.auth);
  });
});

describe('live updates', () => {
  it('a check-in reaches the lecturer’s screen within a second, numbered', async () => {
    const socket = await connect(c.lecturer.token);
    const joined = await join(socket);
    expect(joined.ok).toBe(true);
    at('10:01');
    const started = Date.now();
    const event = nextEvent(socket, 'record.updated');
    await checkIn(c.students[1]!);
    const e = await event;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(e.seq).toBe((joined.seq ?? 0) + 1);
    expect(e.data).toMatchObject({ studentId: c.students[1]!.profileId, status: 'PRESENT' });
  });

  it('lets in only people who may see the roster', async () => {
    const other = await connect(c.otherLecturer.token);
    expect(await join(other)).toEqual({ ok: false, code: 'NOT_YOUR_CLASS' });
    const student = await connect(c.students[0]!.token);
    expect((await join(student)).ok).toBe(false);
    const bad = io(`${baseUrl}/attendance`, {
      auth: { token: 'not-a-token' },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(bad);
    // Refused before it connects.
    const refusal = await new Promise<{ data?: { code?: string } }>((resolve) =>
      bad.on('connect_error', resolve),
    );
    expect(refusal.data?.code).toBe('SIGN_IN_AGAIN');
    expect(bad.connected).toBe(false);
  });

  it('scenario 22: the lecturer’s device crashes; another device continues where it stopped', async () => {
    const first = await connect(c.lecturer.token);
    await join(first);
    at('10:01');
    const seen = nextEvent(first, 'record.updated');
    await checkIn(c.students[0]!);
    const lastSeen = (await seen).seq;
    first.disconnect(); // the phone dies
    await checkIn(c.students[1]!);
    await checkIn(c.students[2]!);
    // The lecturer signs in on a laptop: the roster has everything, and its seq shows what was missed.
    const laptop = await connect(c.lecturer.token);
    const joined = await join(laptop);
    expect(joined.seq).toBe(lastSeen + 2);
    const r = await roster();
    expect(r.counts.PRESENT).toBe(3);
    expect(r.seq).toBe(joined.seq);
    // The QR carries on for the new screen.
    expect(
      (await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)).body
        .token,
    ).toMatch(/^AS1\./);
    expect(
      (await http.get(`/api/v1/attendance-sessions/${attendanceId}`).set(c.lecturer.auth).expect(200)).body
        .status,
    ).toBe('OPEN');
  });

  it('closing is announced, so screens reload', async () => {
    const socket = await connect(c.lecturer.token);
    await join(socket);
    const event = nextEvent(socket, 'session.updated');
    await http
      .post(`/api/v1/attendance-sessions/${attendanceId}/close`)
      .set(c.lecturer.auth)
      .send({})
      .expect(200);
    expect((await event).data).toMatchObject({ status: 'CLOSED', counts: { ABSENT: 4 } });
  });
});

describe('deciding waiting check-ins', () => {
  /** Student 1 checks in on a phone that is not approved yet: waiting for the lecturer. */
  async function waiting(time = '10:05') {
    const s = c.students[0]!;
    const replacement = newPhone();
    const deviceId = await registerPhone(http, s.auth, replacement);
    at(time);
    const result = await checkIn({ ...s, phone: replacement, deviceId });
    expect(result.recordStatus).toBe('PENDING');
    return (await line(s)) as { recordId: string; version: number };
  }

  it('approval makes the student present (judged by when they checked in), with a correction, a decision and an audit entry', async () => {
    const { recordId, version } = await waiting('10:05');
    at('10:30'); // after the late time; the check-in itself was on time
    const decided = (
      await http
        .post(`/api/v1/attendance-records/${recordId}/decide`)
        .set(c.lecturer.auth)
        .send({ decision: 'APPROVE', version })
        .expect(200)
    ).body;
    expect(decided).toMatchObject({ status: 'PRESENT' });
    expect(await prisma.attendanceCorrection.findFirstOrThrow({ where: { recordId } })).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'PRESENT',
      source: 'LECTURER',
      reason: 'Approved by the lecturer.',
    });
    const decisions = await prisma.verificationDecision.findMany({
      where: { attempt: { records: { some: { id: recordId } } } },
      orderBy: { decidedAt: 'asc' },
    });
    expect(decisions.map((d) => d.decidedBy)).toEqual(['ENGINE', 'LECTURER']);
    expect(
      await prisma.auditLog.count({ where: { action: 'attendance.check_in_approved', entityId: recordId } }),
    ).toBe(1);
    // Deciding again is refused: it is no longer waiting.
    expect(
      (
        await http
          .post(`/api/v1/attendance-records/${recordId}/decide`)
          .set(c.lecturer.auth)
          .send({ decision: 'APPROVE', version: version + 1 })
          .expect(409)
      ).body.code,
    ).toBe('NOT_WAITING');
  });

  it('rejecting needs a note; a stale version is refused; other lecturers cannot decide', async () => {
    const { recordId, version } = await waiting();
    await http
      .post(`/api/v1/attendance-records/${recordId}/decide`)
      .set(c.lecturer.auth)
      .send({ decision: 'REJECT', version })
      .expect(400);
    await http
      .post(`/api/v1/attendance-records/${recordId}/decide`)
      .set(c.otherLecturer.auth)
      .send({ decision: 'APPROVE', version })
      .expect(403);
    expect(
      (
        await http
          .post(`/api/v1/attendance-records/${recordId}/decide`)
          .set(c.lecturer.auth)
          .send({ decision: 'APPROVE', version: version + 5 })
          .expect(409)
      ).body.code,
    ).toBe('RECORD_CHANGED');
    const rejected = (
      await http
        .post(`/api/v1/attendance-records/${recordId}/decide`)
        .set(c.admin.auth)
        .send({ decision: 'REJECT', note: 'Was not in the room (test)', version })
        .expect(200)
    ).body;
    expect(rejected.status).toBe('REJECTED');
    expect((await prisma.attendanceCorrection.findFirstOrThrow({ where: { recordId } })).source).toBe(
      'ADMINISTRATOR',
    );
  });

  it('in degraded mode, approves together only the check-ins that wait because of the beacon', async () => {
    at('10:01');
    expect(
      (
        await http
          .post(`/api/v1/attendance-sessions/${attendanceId}/approve-waiting`)
          .set(c.lecturer.auth)
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('NOT_DEGRADED');
    for (const s of c.students.slice(1, 4)) await checkIn(s, silent); // three silent phones: degraded
    const extra = await c.addStudent(5);
    expect((await checkIn(extra, silent)).reason).toBe('DEGRADED_MODE');
    await waiting('10:06'); // student 1: waiting because of a new phone, not the beacon
    const result = (
      await http
        .post(`/api/v1/attendance-sessions/${attendanceId}/approve-waiting`)
        .set(c.lecturer.auth)
        .send({})
        .expect(200)
    ).body;
    expect(result.approved).toBeGreaterThanOrEqual(1);
    expect((await line(extra)).status).toBe('PRESENT');
    expect((await line(c.students[0]!)).status).toBe('PENDING'); // still needs its own decision
  });
});

describe('assisted check-in', () => {
  it('checks in a student without a working phone, keeping how and why', async () => {
    at('10:03');
    const s = c.students[2]!;
    const result = (
      await http
        .post(`/api/v1/attendance-sessions/${attendanceId}/assisted-check-ins`)
        .set(c.lecturer.auth)
        .send({ studentId: s.profileId, method: 'PHONE_UNAVAILABLE', reason: 'Phone battery dead (test)' })
        .expect(201)
    ).body;
    expect(result).toMatchObject({ status: 'PRESENT', source: 'ASSISTED' });
    expect(
      await prisma.assistedCheckIn.findFirstOrThrow({ where: { studentId: s.profileId } }),
    ).toMatchObject({ method: 'PHONE_UNAVAILABLE' });
    expect(
      (
        await http
          .post(`/api/v1/attendance-sessions/${attendanceId}/assisted-check-ins`)
          .set(c.lecturer.auth)
          .send({ studentId: s.profileId, method: 'OTHER', reason: 'Again (test)' })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_RECORDED');
  });

  it('raises an absence after closing (with a correction), and covers a student who enrolled late', async () => {
    at('10:05');
    await http
      .post(`/api/v1/attendance-sessions/${attendanceId}/close`)
      .set(c.lecturer.auth)
      .send({})
      .expect(200);
    at('10:20');
    const s = c.students[3]!;
    const raised = (
      await http
        .post(`/api/v1/attendance-sessions/${attendanceId}/assisted-check-ins`)
        .set(c.lecturer.auth)
        .send({ studentId: s.profileId, method: 'NO_SMARTPHONE', reason: 'No smartphone (test)' })
        .expect(201)
    ).body;
    expect(raised.status).toBe('LATE');
    expect(
      await prisma.attendanceCorrection.findFirstOrThrow({ where: { record: { studentId: s.profileId } } }),
    ).toMatchObject({ fromStatus: 'ABSENT', toStatus: 'LATE', source: 'LECTURER' });
    const late = await c.addStudent(6, { enrolledAt: '2030-08-20T10:10:00Z' });
    await http
      .post(`/api/v1/attendance-sessions/${attendanceId}/assisted-check-ins`)
      .set(c.lecturer.auth)
      .send({ studentId: late.profileId, method: 'LATE_ENROLMENT', reason: 'Joined the course today (test)' })
      .expect(201);
  });

  it('only for the class’s own students, by its lecturer, while it runs', async () => {
    const outsider = await c.addStudent(7, { sectionId: c.otherSectionId });
    const send = (auth: Record<string, string>, studentId: string) =>
      http
        .post(`/api/v1/attendance-sessions/${attendanceId}/assisted-check-ins`)
        .set(auth)
        .send({ studentId, method: 'OTHER', reason: 'Test reason (test)' });
    expect((await send(c.lecturer.auth, outsider.profileId).expect(409)).body.code).toBe('NOT_IN_CLASS');
    await send(c.otherLecturer.auth, c.students[0]!.profileId).expect(403);
    await send(c.admin.auth, c.students[0]!.profileId).expect(403); // administrators correct records instead
    at('10:10');
    await http.post(`/api/v1/class-sessions/${c.classId}/end`).set(c.lecturer.auth).expect(200);
    expect((await send(c.lecturer.auth, c.students[0]!.profileId).expect(409)).body.code).toBe(
      'CLASS_NOT_RUNNING',
    );
  });
});
