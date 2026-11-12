import { randomUUID } from 'node:crypto';
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
import { AttendanceSessionsService } from '../src/modules/attendance/attendance-sessions.service.js';
import {
  buildClass,
  inRoom,
  newPhone,
  north,
  registerPhone,
  sessionFor,
  signedCheckIn,
  silent,
  type Student,
} from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// Phase 5 exit check: one simulated class, from opening attendance to the student's percentage,
// through the real API, with TESTING.md scenarios 1–12 and 22 happening in it the way they would in
// a lecture. (Scenario 25 at full size is test/load-check-ins.test.ts.) Obviously fake data: a made-up
// class on Tuesday 2030-08-20 10:00–11:30, twelve made-up students (99000001–99000012), late after
// 15 minutes and closing after 20 (the interim settings, D-09).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (hhmmss: string) => clock.set(`2030-08-20T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}Z`);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let baseUrl: string;
let c: Awaited<ReturnType<typeof buildClass>>;
let s: Student[];
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
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 12 });
  s = c.students;
}, 120_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await app?.close();
});

type LiveEvent = { seq: number; type: string; data: { studentId?: string; status?: string } };

/** The lecturer's live roster on one device. */
async function liveDevice(token: string, attendanceSessionId: string) {
  const socket = io(`${baseUrl}/attendance`, {
    auth: { token },
    path: '/api/v1/live',
    addTrailingSlash: false,
    transports: ['websocket'],
    forceNew: true,
  });
  sockets.push(socket);
  const events: LiveEvent[] = [];
  socket.on('attendance', (e: LiveEvent) => events.push(e));
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
  const joined = (await socket.timeout(5000).emitWithAck('join', { attendanceSessionId })) as {
    ok: boolean;
    seq: number;
  };
  expect(joined.ok).toBe(true);
  return { socket, events, joinedAt: joined.seq };
}

describe('a simulated class, start to finish', () => {
  it('runs the class the way the design says, and every number agrees at the end', async () => {
    // ── 10:00 The lecturer starts the class and opens attendance; the dashboard is live. ──
    at('10:00');
    const opened = (
      await http
        .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
        .set(c.lecturer.auth)
        .send({ startClass: true })
        .expect(201)
    ).body;
    const id = opened.id as string;
    const qr = async () =>
      (await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(c.lecturer.auth).expect(200)).body
        .token as string;
    const checkIn = async (who: Student, body: object, key?: string) =>
      (await signedCheckIn(http, clock, who, body, key).expect(200)).body;
    const roster = async () =>
      (await http.get(`/api/v1/attendance-sessions/${id}/roster`).set(c.lecturer.auth).expect(200)).body;
    const lineOf = async (who: Student) =>
      (await roster()).students.find((l: { studentId: string }) => l.studentId === who.profileId);
    const deviceA = await liveDevice(c.lecturer.token, id);
    const at1000 = await qr(); // what a student photographs at 10:00

    // ── 10:01 Students check in. ──
    at('10:01');
    // Scenario 1: in the room, on time.
    expect(await checkIn(s[0]!, inRoom(await qr()))).toMatchObject({
      outcome: 'VERIFIED',
      recordStatus: 'PRESENT',
    });
    // Scenarios 2 and 4: the live code sent to a friend at home is no use there (clearly away from
    // campus, so no retry is suggested).
    expect(
      await checkIn(s[2]!, { ...inRoom(await qr()), readings: [], location: north(8000) }),
    ).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NOT_IN_CLASSROOM',
      retryAllowed: false,
    });
    expect(
      await checkIn(s[1]!, { ...inRoom(await qr()), readings: [], location: north(8000) }),
    ).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NOT_IN_CLASSROOM',
    });
    // Scenario 7: a nervous double-tap on a bad connection, sent three times at once.
    const key = randomUUID();
    const body4 = inRoom(await qr());
    const triple = await Promise.all([1, 2, 3].map(() => checkIn(s[4]!, body4, key)));
    expect(new Set(triple.map((r) => r.attemptId)).size).toBe(1);
    expect(await prisma.attendanceAttempt.count({ where: { studentId: s[4]!.profileId } })).toBe(1);
    // Scenario 8: Bluetooth off, then on.
    expect(await checkIn(s[5]!, { ...inRoom(await qr()), bluetooth: 'OFF', readings: [] })).toMatchObject({
      reason: 'BLUETOOTH_OFF',
      retryAllowed: true,
    });
    expect((await checkIn(s[5]!, inRoom(await qr()))).recordStatus).toBe('PRESENT');
    // Scenario 10: a vague location (±400 m) is never held against a student the beacon places in the room.
    expect(await checkIn(s[6]!, { ...inRoom(await qr()), location: north(30, 400) })).toMatchObject({
      outcome: 'VERIFIED',
      recordStatus: 'PRESENT',
    });
    // Scenario 11: a new phone, not yet approved, waits for the lecturer.
    const replacement = newPhone();
    const newPhoneId = await registerPhone(http, s[7]!.auth, replacement);
    expect(
      await checkIn({ ...s[7]!, phone: replacement, deviceId: newPhoneId }, inRoom(await qr())),
    ).toMatchObject({ outcome: 'PENDING_VERIFICATION', reason: 'NEW_DEVICE', recordStatus: 'PENDING' });
    // Scenario 12: scanned at 10:00, sent at 10:01 when the connection came back: waits for the lecturer.
    expect(await checkIn(s[8]!, inRoom(at1000))).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'DELAYED_UPLOAD',
      recordStatus: 'PENDING',
    });
    // Scenario 6: a student of another course. Scenario 5: someone who is not a student at all.
    const outsider = await c.addStudent(99, { sectionId: c.otherSectionId });
    expect(await checkIn(outsider, inRoom(await qr()))).toMatchObject({
      reason: 'NOT_ENROLLED',
      recordStatus: null,
    });
    const lecturerPhone = newPhone();
    const lecturerAsStudent: Student = {
      ...c.lecturer,
      phone: lecturerPhone,
      deviceId: await registerPhone(http, c.lecturer.auth, lecturerPhone),
      profileId: c.lecturer.userId,
    };
    expect(
      (await signedCheckIn(http, clock, lecturerAsStudent, inRoom(await qr())).expect(403)).body.code,
    ).toBe('NOT_A_STUDENT');

    // The lecturer's dashboard heard each change to the roster as it happened.
    await expect
      .poll(() => new Set(deviceA.events.map((e) => e.data.studentId)).size, { timeout: 5000 })
      .toBeGreaterThanOrEqual(7);

    // ── 10:03 Scenario 3: a screenshot from 10:00 is expired and creates no record. ──
    at('10:03');
    expect(await checkIn(s[3]!, inRoom(at1000))).toMatchObject({ reason: 'QR_EXPIRED', recordStatus: null });
    expect(await lineOf(s[3]!)).toMatchObject({ status: null });
    // The student explains their phone has died; the lecturer checks them in by hand, with a reason.
    await http
      .post(`/api/v1/attendance-sessions/${id}/assisted-check-ins`)
      .set(c.lecturer.auth)
      .send({ studentId: s[3]!.profileId, method: 'PHONE_UNAVAILABLE', reason: 'Phone battery died (test)' })
      .expect(201);
    expect((await lineOf(s[3]!)).status).toBe('PRESENT');

    // ── 10:05 The lecturer decides the waiting check-ins. ──
    at('10:05');
    const waiting7 = await lineOf(s[7]!);
    await http
      .post(`/api/v1/attendance-records/${waiting7.recordId}/decide`)
      .set(c.lecturer.auth)
      .send({ decision: 'APPROVE', version: waiting7.version })
      .expect(200);
    const waiting8 = await lineOf(s[8]!);
    await http
      .post(`/api/v1/attendance-records/${waiting8.recordId}/decide`)
      .set(c.lecturer.auth)
      .send({ decision: 'REJECT', note: 'Not seen in the room (test)', version: waiting8.version })
      .expect(200);
    expect((await lineOf(s[7]!)).status).toBe('PRESENT'); // approved by the time it was received
    expect((await lineOf(s[8]!)).status).toBe('REJECTED');

    // ── 10:10 Scenario 22: the lecturer's phone crashes. ──
    at('10:10');
    const lastSeenOnA = Math.max(deviceA.joinedAt, ...deviceA.events.map((e) => e.seq));
    deviceA.socket.disconnect();

    // ── 10:12 Scenario 9: the beacon stops. No phone has heard it for 10 minutes, and three phones
    // on site with Bluetooth on hear nothing (the 10:01 phone from home and the Bluetooth-off phone
    // prove nothing and are not counted). ──
    at('10:12');
    // Before the fault is known, each waits for the lecturer ("no classroom signal"), and is told so.
    for (const who of [s[10]!, s[1]!, s[2]!]) {
      expect(await checkIn(who, silent(await qr()))).toMatchObject({
        outcome: 'PENDING_VERIFICATION',
        reason: 'NO_CLASSROOM_SIGNAL',
        message: 'We couldn’t detect the classroom, so your lecturer will confirm your check-in.',
      });
    }
    expect((await prisma.beacon.findUniqueOrThrow({ where: { id: c.beaconId } })).status).toBe(
      'SUSPECTED_FAULTY',
    );
    expect((await roster()).degraded).toBe(true);
    // Nobody is rejected for the beacon's fault: their retries wait for the lecturer.
    for (const who of [s[10]!, s[1]!, s[2]!]) {
      expect(await checkIn(who, silent(await qr()))).toMatchObject({
        outcome: 'PENDING_VERIFICATION',
        reason: 'DEGRADED_MODE',
        recordStatus: 'PENDING',
      });
    }

    // ── 10:13 The lecturer picks up another device: it sees it missed events (seq), reloads the
    // roster, finds the waiting check-ins, and the code carries on. ──
    at('10:13');
    const otherDevice = await sessionFor(app, c.lecturer.userId, 'LECTURER');
    const deviceB = await liveDevice(otherDevice.token, id);
    expect(deviceB.joinedAt).toBeGreaterThan(lastSeenOnA);
    const reloaded = (
      await http.get(`/api/v1/attendance-sessions/${id}/roster`).set(otherDevice.auth).expect(200)
    ).body;
    expect(reloaded.degraded).toBe(true);
    expect(
      reloaded.students
        .filter((l: { status: string }) => l.status === 'PENDING')
        .map((l: { studentId: string }) => l.studentId)
        .sort(),
    ).toEqual([s[10]!, s[1]!, s[2]!].map((who) => who.profileId).sort());
    await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(otherDevice.auth).expect(200);
    // In degraded mode the lecturer approves the waiting check-ins together, including the three whose
    // silent phones showed the fault (received 10:12: on time).
    await http
      .post(`/api/v1/attendance-sessions/${id}/approve-waiting`)
      .set(otherDevice.auth)
      .send({})
      .expect(200);
    for (const who of [s[10]!, s[1]!, s[2]!]) expect((await lineOf(who)).status).toBe('PRESENT');
    await expect
      .poll(() => deviceB.events.filter((e) => e.type === 'record.updated').length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(3);

    // ── 10:16 A late arrival, and the beacon is heard again: it is working, and so is the check-in. ──
    at('10:16');
    expect(await checkIn(s[9]!, inRoom(await qr()))).toMatchObject({
      outcome: 'VERIFIED',
      recordStatus: 'LATE',
    });
    expect((await prisma.beacon.findUniqueOrThrow({ where: { id: c.beaconId } })).status).toBe('ACTIVE');

    // ── 10:21 The server closes attendance on time (server time, never the phone's). ──
    at('10:21');
    expect((await app.get(AttendanceSessionsService).sweep()).closed).toBe(1);
    expect(await checkIn(s[11]!, inRoom(at1000))).toMatchObject({ outcome: 'REJECTED' });
    const closed = await roster();
    expect((await lineOf(s[11]!)).status).toBe('ABSENT'); // never checked in

    // ── After class: the student who never checked in signed the paper register. ──
    const absent = await lineOf(s[11]!);
    const corrected = (
      await http
        .post(`/api/v1/attendance-records/${absent.recordId}/correct`)
        .set(c.lecturer.auth)
        .send({ status: 'PRESENT', reason: 'Signed the paper register (test)', version: absent.version })
        .expect(200)
    ).body;
    expect(corrected).toMatchObject({ applied: true, record: { status: 'PRESENT' } });
    const history = (
      await http.get(`/api/v1/attendance-records/${absent.recordId}/history`).set(c.lecturer.auth).expect(200)
    ).body;
    expect(JSON.stringify(history)).toContain('Signed the paper register (test)');

    // ── The numbers agree everywhere. ──
    const final = await roster();
    const statusOf = new Map(
      final.students.map((l: { studentId: string; status: string }) => [l.studentId, l.status]),
    );
    expect(s.map((who) => statusOf.get(who.profileId))).toEqual([
      'PRESENT', // 0 on time
      'PRESENT', // 1 from home, then in the room during degraded mode, approved
      'PRESENT', // 2 likewise
      'PRESENT', // 3 screenshot, then checked in by hand
      'PRESENT', // 4 triple request
      'PRESENT', // 5 Bluetooth off, then on
      'PRESENT', // 6 vague location
      'PRESENT', // 7 new phone, approved
      'REJECTED', // 8 delayed upload, rejected with a note
      'LATE', // 9 late arrival
      'PRESENT', // 10 degraded mode, approved
      'PRESENT', // 11 absent, corrected with a reason
    ]);
    expect(final.counts).toMatchObject({ PRESENT: 10, LATE: 1, REJECTED: 1, enrolled: 12 });
    expect(closed.counts.ABSENT).toBe(1);
    // Nothing was overwritten silently: the decisions, the hand check-in, the correction and the
    // close are all in the audit log; records exist only for the class's own students.
    expect(await prisma.attendanceRecord.count({ where: { attendanceSessionId: id } })).toBe(12);
    // Every change after a check-in has a row with a reason and the person: two single decisions,
    // three approved together, one correction.
    const changes = await prisma.attendanceCorrection.findMany();
    expect(changes).toHaveLength(6);
    expect(changes.every((ch) => ch.reason.length > 0 && ch.correctedById === c.lecturer.userId)).toBe(true);
    // Each person's action and each change the system made to a beacon is in the audit log…
    const actions = new Set(
      (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action),
    );
    for (const action of [
      'class_sessions.start',
      'attendance.opened',
      'attendance.assisted_check_in',
      'attendance.check_in_approved',
      'attendance.check_in_rejected',
      'attendance.waiting_approved',
      'attendance.corrected',
      'beacons.suspected_faulty',
      'beacons.heard_again',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    // …and the server's own close is in the class's event log, with why and how many were marked absent.
    const closeEvent = await prisma.classEvent.findFirstOrThrow({
      where: { classSessionId: c.classId, type: 'ATTENDANCE_CLOSED' },
    });
    expect(closeEvent).toMatchObject({ actorType: 'SYSTEM', payload: { reason: 'AUTO', absentMarked: 1 } });
    // ── 11:30 The lecturer ends the class; only now does it count. ──
    at('11:30');
    expect(
      (await http.get('/api/v1/me/attendance').set(s[0]!.auth).expect(200)).body.data[0].percentage,
    ).toBeNull(); // not held yet
    await http.post(`/api/v1/class-sessions/${c.classId}/end`).set(c.lecturer.auth).send({}).expect(200);
    // The students see the same thing as the lecturer, from the server's own calculation.
    const mine = async (who: Student) =>
      (await http.get('/api/v1/me/attendance').set(who.auth).expect(200)).body.data[0];
    expect(await mine(s[0]!)).toMatchObject({ present: 1, late: 0, absences: 0, percentage: 100 });
    expect(await mine(s[8]!)).toMatchObject({ present: 0, absences: 1, percentage: 0 });
  }, 120_000);
});
