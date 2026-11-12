import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { AttendanceSessionsService } from '../src/modules/attendance/attendance-sessions.service.js';
import { CorrectionsService } from '../src/modules/attendance/corrections.service.js';
import {
  buildClass,
  inRoom,
  newPhone,
  registerPhone,
  signedCheckIn,
  type Student,
} from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// Corrections (Phase 5 step 4) and TESTING.md scenario 20 (a lecturer's authorised correction).
// Obviously fake data; the class is Tuesday 2030-08-20 10:00–11:30 (Africa/Accra = UTC).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso.length === 5 ? `2030-08-20T${iso}:00Z` : iso);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let corrections: CorrectionsService;
let c: Awaited<ReturnType<typeof buildClass>>;
let attendanceId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
  corrections = app.get(CorrectionsService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  at('09:58');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
  attendanceId = (
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({})
      .expect(201)
  ).body.id;
});

const recordOf = (s: Student) =>
  prisma.attendanceRecord.findUniqueOrThrow({
    where: { classSessionId_studentId: { classSessionId: c.classId, studentId: s.profileId } },
  });
const close = () =>
  http.post(`/api/v1/attendance-sessions/${attendanceId}/close`).set(c.lecturer.auth).send({}).expect(200);
const correct = (auth: Record<string, string>, recordId: string, body: object) =>
  http.post(`/api/v1/attendance-records/${recordId}/correct`).set(auth).send(body);

describe('scenario 20: a lecturer’s authorised correction', () => {
  it('corrects within the window, with a reason, a correction row, an audit entry and a live update', async () => {
    at('10:05');
    await close();
    const before = await recordOf(c.students[0]!);
    expect(before.status).toBe('ABSENT');
    const result = (
      await correct(c.lecturer.auth, before.id, {
        status: 'PRESENT',
        reason: 'Signed the paper register (test)',
        version: before.version,
      }).expect(200)
    ).body;
    expect(result).toMatchObject({ applied: true, record: { status: 'PRESENT' } });
    expect(
      await prisma.attendanceCorrection.findFirstOrThrow({ where: { recordId: before.id } }),
    ).toMatchObject({
      fromStatus: 'ABSENT',
      toStatus: 'PRESENT',
      source: 'LECTURER',
      reason: 'Signed the paper register (test)',
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'attendance.corrected', entityId: before.id } }),
    ).toBe(1);
    // Corrections may lower a record too (that is the point of an audited correction).
    const now = await recordOf(c.students[0]!);
    await correct(c.lecturer.auth, before.id, {
      status: 'ABSENT',
      reason: 'Wrong student marked (test)',
      version: now.version,
    }).expect(200);
  });

  it('refuses without a reason, with a stale version, with no change, or for someone else’s class', async () => {
    at('10:05');
    await close();
    const r = await recordOf(c.students[0]!);
    await correct(c.lecturer.auth, r.id, { status: 'PRESENT', version: r.version }).expect(400);
    expect(
      (
        await correct(c.lecturer.auth, r.id, {
          status: 'PRESENT',
          reason: 'Stale (test)',
          version: r.version + 3,
        }).expect(409)
      ).body.code,
    ).toBe('RECORD_CHANGED');
    expect(
      (
        await correct(c.lecturer.auth, r.id, {
          status: 'ABSENT',
          reason: 'Same (test)',
          version: r.version,
        }).expect(409)
      ).body.code,
    ).toBe('NO_CHANGE');
    await correct(c.otherLecturer.auth, r.id, {
      status: 'PRESENT',
      reason: 'Not mine (test)',
      version: r.version,
    }).expect(403);
    await correct(c.students[0]!.auth, r.id, {
      status: 'PRESENT',
      reason: 'Myself (test)',
      version: r.version,
    }).expect(403);
    await correct(c.lecturer.auth, r.id, {
      status: 'EXCUSED',
      reason: 'Excused (test)',
      version: r.version,
    }).expect(400);
  });

  it('waiting check-ins are decided, not corrected; voided records cannot be corrected', async () => {
    const s = c.students[1]!;
    const replacement = newPhone();
    const deviceId = await registerPhone(http, s.auth, replacement);
    at('10:02');
    const token = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)
    ).body.token;
    await signedCheckIn(http, clock, { ...s, phone: replacement, deviceId }, inRoom(token)).expect(200);
    const waiting = await recordOf(s);
    expect(
      (
        await correct(c.lecturer.auth, waiting.id, {
          status: 'PRESENT',
          reason: 'Was here (test)',
          version: waiting.version,
        }).expect(409)
      ).body.code,
    ).toBe('DECIDE_INSTEAD');
    await close();
    await http
      .post(`/api/v1/class-sessions/${c.classId}/void`)
      .set(c.admin.auth)
      .send({ reason: 'Wrong group (test)' })
      .expect(200);
    await app.get(AttendanceSessionsService).sweep();
    const voided = await recordOf(c.students[0]!);
    expect(
      (
        await correct(c.admin.auth, voided.id, {
          status: 'PRESENT',
          reason: 'Try (test)',
          version: voided.version,
        }).expect(409)
      ).body.code,
    ).toBe('NOT_CORRECTABLE');
  });
});

describe('late corrections', () => {
  it('after the window a lecturer’s correction waits for an administrator, who approves it', async () => {
    at('10:05');
    await close();
    const r = await recordOf(c.students[0]!);
    at('2030-09-05T09:00:00Z'); // 16 days later
    const asked = await correct(c.lecturer.auth, r.id, {
      status: 'PRESENT',
      reason: 'Found the paper register (test)',
      version: r.version,
    }).expect(202);
    expect(asked.body).toMatchObject({
      applied: false,
      request: { status: 'PENDING', from: 'ABSENT', to: 'PRESENT' },
    });
    expect((await recordOf(c.students[0]!)).status).toBe('ABSENT'); // nothing changes yet
    expect(
      (
        await correct(c.lecturer.auth, r.id, {
          status: 'LATE',
          reason: 'Again (test)',
          version: r.version,
        }).expect(409)
      ).body.code,
    ).toBe('REQUEST_PENDING');
    expect(
      await prisma.notification.count({
        where: { category: 'CORRECTION_REQUESTED', userId: c.admin.userId },
      }),
    ).toBe(1);

    const list = (await http.get('/api/v1/attendance-correction-requests').set(c.admin.auth).expect(200)).body
      .data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      student: { studentNumber: '99000001' },
      requestedBy: { fullName: expect.any(String) },
    });
    await http.get('/api/v1/attendance-correction-requests').set(c.lecturer.auth).expect(403);

    const id = list[0].id;
    await http
      .post(`/api/v1/attendance-correction-requests/${id}/decide`)
      .set(c.admin.auth)
      .send({ decision: 'APPROVE' })
      .expect(200);
    expect((await recordOf(c.students[0]!)).status).toBe('PRESENT');
    expect(await prisma.attendanceCorrection.findFirstOrThrow({ where: { recordId: r.id } })).toMatchObject({
      source: 'ADMINISTRATOR',
      sourceId: id,
      correctedById: c.admin.userId,
    });
    expect(
      await prisma.notification.count({
        where: { category: 'CORRECTION_DECIDED', userId: c.lecturer.userId },
      }),
    ).toBe(1);
    expect(
      (
        await http
          .post(`/api/v1/attendance-correction-requests/${id}/decide`)
          .set(c.admin.auth)
          .send({ decision: 'REJECT', note: 'Too late (test)' })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_DECIDED');
  });

  it('an approval never applies to a record that changed since; a rejection needs a note', async () => {
    at('10:05');
    await close();
    const r = await recordOf(c.students[0]!);
    at('2030-09-05T09:00:00Z');
    const id = (
      await correct(c.lecturer.auth, r.id, {
        status: 'PRESENT',
        reason: 'Paper register (test)',
        version: r.version,
      }).expect(202)
    ).body.request.id;
    await http
      .post(`/api/v1/attendance-correction-requests/${id}/decide`)
      .set(c.admin.auth)
      .send({ decision: 'REJECT' })
      .expect(400);
    // An administrator corrects the record directly in the meantime.
    await correct(c.admin.auth, r.id, {
      status: 'LATE',
      reason: 'Arrived late (test)',
      version: r.version,
    }).expect(200);
    expect(
      (
        await http
          .post(`/api/v1/attendance-correction-requests/${id}/decide`)
          .set(c.admin.auth)
          .send({ decision: 'APPROVE' })
          .expect(409)
      ).body.code,
    ).toBe('RECORD_CHANGED');
    expect((await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PENDING',
    ); // nothing half-done
    await http
      .post(`/api/v1/attendance-correction-requests/${id}/decide`)
      .set(c.admin.auth)
      .send({ decision: 'REJECT', note: 'Already corrected (test)' })
      .expect(200);
    expect((await recordOf(c.students[0]!)).status).toBe('LATE');
  });
});

describe('history', () => {
  it('shows every change, the check-ins and decisions behind it', async () => {
    at('10:01');
    const token = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)
    ).body.token;
    await signedCheckIn(http, clock, c.students[0]!, inRoom(token)).expect(200);
    const r = await recordOf(c.students[0]!);
    await correct(c.lecturer.auth, r.id, {
      status: 'ABSENT',
      reason: 'Left after scanning (test)',
      version: r.version,
    }).expect(200);
    const history = (
      await http.get(`/api/v1/attendance-records/${r.id}/history`).set(c.lecturer.auth).expect(200)
    ).body;
    expect(history.record.status).toBe('ABSENT');
    expect(history.corrections).toEqual([
      expect.objectContaining({
        from: 'PRESENT',
        to: 'ABSENT',
        source: 'LECTURER',
        reason: 'Left after scanning (test)',
      }),
    ]);
    expect(history.attempts[0]).toMatchObject({
      outcome: 'VERIFIED',
      decisions: [expect.objectContaining({ decidedBy: 'ENGINE' })],
    });
    await http.get(`/api/v1/attendance-records/${r.id}/history`).set(c.otherLecturer.auth).expect(403);
  });
});

describe('undecided check-ins', () => {
  it('remind the lecturer at the end and next morning, go to administrators after 72 hours, and are never made absent', async () => {
    const s = c.students[2]!;
    const replacement = newPhone();
    const deviceId = await registerPhone(http, s.auth, replacement);
    at('10:02');
    const token = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)
    ).body.token;
    await signedCheckIn(http, clock, { ...s, phone: replacement, deviceId }, inRoom(token)).expect(200);
    await close();
    at('11:00');
    expect(await corrections.remindUndecided()).toEqual({ reminded: 0, escalated: 0 }); // the class has not ended
    at('11:31');
    expect(await corrections.remindUndecided()).toEqual({ reminded: 1, escalated: 0 });
    expect(await corrections.remindUndecided()).toEqual({ reminded: 0, escalated: 0 }); // once
    at('2030-08-21T08:00:00Z');
    expect(await corrections.remindUndecided()).toEqual({ reminded: 1, escalated: 0 }); // next morning
    at('2030-08-23T10:02:00Z'); // 72 hours after closing
    expect(await corrections.remindUndecided()).toEqual({ reminded: 0, escalated: 1 });
    expect(await corrections.remindUndecided()).toEqual({ reminded: 0, escalated: 0 });
    expect(
      await prisma.notification.count({
        where: { category: 'ATTENDANCE_DECISIONS_ESCALATED', userId: c.admin.userId },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { category: 'ATTENDANCE_DECISIONS_WAITING', userId: c.lecturer.userId },
      }),
    ).toBe(2);
    expect((await recordOf(s)).status).toBe('PENDING');
  });
});
