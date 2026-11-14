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
import { DisputesService } from '../src/modules/requests/disputes.service.js';
import { buildClass, inRoom, north, signedCheckIn, type Student } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// Attendance disputes (Phase 6 step 2, decision D-21) and TESTING.md scenario 19 (a student disputes
// their attendance). Obviously fake data; the class is Tuesday 2030-08-20 10:00–11:30 (Africa/Accra = UTC).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso.length === 5 ? `2030-08-20T${iso}:00Z` : iso);
const FAKE_PDF = Buffer.from('%PDF-1.4\n% obviously fake test document\n%%EOF\n');

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
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

const close = () =>
  http.post(`/api/v1/attendance-sessions/${attendanceId}/close`).set(c.lecturer.auth).send({}).expect(200);
const recordOf = (s: Student) =>
  prisma.attendanceRecord.findUniqueOrThrow({
    where: { classSessionId_studentId: { classSessionId: c.classId, studentId: s.profileId } },
  });
const dispute = (s: Student, reason = 'I was in the front row from 09:55 (test).') =>
  http.post('/api/v1/disputes').set(s.auth).send({ classSessionId: c.classId, reason });
const act = (auth: Record<string, string>, id: string, action: string, body: object = {}) =>
  http.post(`/api/v1/disputes/${id}/${action}`).set(auth).send(body);
const notificationsFor = (userId: string, category: string) =>
  prisma.notification.findMany({ where: { userId, category } });

describe('scenario 19: a student disputes their attendance', () => {
  it('disputes an absence, answers a question, attaches a file; the lecturer approves and the record changes with a full trail', async () => {
    at('10:25');
    await close();
    const s = c.students[0]!;
    const before = await recordOf(s);
    expect(before.status).toBe('ABSENT');

    // The student sends the dispute; the record does not change, and the lecturer is told.
    const sent = (await dispute(s).expect(201)).body;
    expect(sent).toMatchObject({
      status: 'SUBMITTED',
      record: { id: before.id, statusWhenDisputed: 'ABSENT', status: 'ABSENT' },
      class: { id: c.classId },
      student: { id: s.profileId },
    });
    expect((await recordOf(s)).status).toBe('ABSENT');
    expect(await notificationsFor(c.lecturer.userId, 'DISPUTE_SUBMITTED')).toHaveLength(1);
    expect((await dispute(s).expect(409)).body.code).toBe('DISPUTE_OPEN'); // one open dispute per record

    // The lecturer asks a question; the student is told and answers.
    at('11:00');
    expect(
      (
        await act(c.lecturer.auth, sent.id, 'request-info', {
          question: 'Which seat were you in? (test)',
        }).expect(200)
      ).body.status,
    ).toBe('INFO_REQUESTED');
    expect(await notificationsFor(s.userId, 'DISPUTE_INFO_REQUESTED')).toHaveLength(1);
    expect(
      (await act(s.auth, sent.id, 'respond', { reply: 'Front row, by the window (test).' }).expect(200)).body
        .status,
    ).toBe('SUBMITTED');
    expect(await notificationsFor(c.lecturer.userId, 'DISPUTE_REPLIED')).toHaveLength(1);

    // A supporting file, checked from its bytes; only the student and the reviewers can fetch it.
    const withFile = (
      await http
        .post(`/api/v1/disputes/${sent.id}/attachments`)
        .set(s.auth)
        .attach('file', FAKE_PDF, 'note.pdf')
        .expect(201)
    ).body;
    expect(withFile.attachments).toEqual([
      expect.objectContaining({ name: 'note.pdf', mimeType: 'application/pdf', sizeBytes: FAKE_PDF.length }),
    ]);
    const fileId = withFile.attachments[0].fileId as string;
    expect(
      (
        await http
          .post(`/api/v1/disputes/${sent.id}/attachments`)
          .set(s.auth)
          .attach('file', Buffer.from('not a pdf at all (test)'), 'fake.pdf')
          .expect(400)
      ).body.code,
    ).toBe('UNSUPPORTED_FILE_TYPE');
    expect(
      (await http.get(`/api/v1/disputes/${sent.id}/attachments/${fileId}`).set(c.lecturer.auth).expect(200))
        .body.url,
    ).toBeTruthy();
    await http.get(`/api/v1/disputes/${sent.id}/attachments/${fileId}`).set(c.students[1]!.auth).expect(404);

    // The lecturer sees the whole conversation and the check-in attempts, then approves as late.
    const seen = (await http.get(`/api/v1/disputes/${sent.id}`).set(c.lecturer.auth).expect(200)).body;
    expect(seen.messages.map((m: { kind: string }) => m.kind)).toEqual(['QUESTION', 'REPLY']);
    at('11:10');
    const approved = (
      await act(c.lecturer.auth, sent.id, 'approve', {
        status: 'LATE',
        note: 'Seen arriving late (test).',
      }).expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'APPROVED', outcome: 'LATE', record: { status: 'LATE' } });

    // The record changed once, with a correction naming the dispute, and audit entries for each step.
    const after = await recordOf(s);
    expect(after).toMatchObject({ status: 'LATE', version: before.version + 1 });
    const correction = await prisma.attendanceCorrection.findFirstOrThrow({ where: { recordId: before.id } });
    expect(correction).toMatchObject({
      fromStatus: 'ABSENT',
      toStatus: 'LATE',
      source: 'DISPUTE',
      sourceId: sent.id,
      correctedById: c.lecturer.userId,
    });
    expect(correction.reason).toContain('I was in the front row');
    const actions = (await prisma.auditLog.findMany({ where: { entityId: sent.id } })).map((a) => a.action);
    expect(actions.sort()).toEqual([
      'disputes.approved',
      'disputes.attachment_added',
      'disputes.info_requested',
      'disputes.replied',
      'disputes.submitted',
    ]);
    expect(await notificationsFor(s.userId, 'DISPUTE_DECIDED')).toHaveLength(1);
    expect(
      (await act(c.lecturer.auth, sent.id, 'reject', { note: 'Changed my mind (test)' }).expect(409)).body
        .code,
    ).toBe('ALREADY_DECIDED');
    // The conversation and the files are history.
    await expect(prisma.disputeMessage.updateMany({ data: { body: 'edited' } })).rejects.toThrow();
    await expect(prisma.disputeAttachment.deleteMany({})).rejects.toThrow();
  });
});

describe('what can be disputed', () => {
  it('only the student’s own absent or rejected record, after attendance closed, within the window', async () => {
    const [present, absent] = [c.students[0]!, c.students[1]!];
    at('10:01');
    const qr = (
      await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)
    ).body.token as string;
    await signedCheckIn(http, clock, present, inRoom(qr)).expect(200);
    expect((await dispute(absent).expect(409)).body.code).toBe('NO_RECORD'); // no record while attendance is open
    // A rejected check-in (sent from far away) makes a record while attendance is still open: the
    // student can try again, so a dispute is not accepted yet.
    const far = c.students[2]!;
    expect(
      (
        await signedCheckIn(http, clock, far, { ...inRoom(qr), readings: [], location: north(8000) }).expect(
          200,
        )
      ).body.recordStatus,
    ).toBe('REJECTED');
    expect((await dispute(far).expect(409)).body.code).toBe('ATTENDANCE_STILL_OPEN');
    at('10:25');
    await close();
    expect((await dispute(present).expect(409)).body.code).toBe('NOT_DISPUTABLE');
    await http
      .post('/api/v1/disputes')
      .set(c.lecturer.auth)
      .send({ classSessionId: c.classId, reason: 'Not a student (test).' })
      .expect(403);
    await dispute(absent, 'short').expect(400);
    // 14 days after the class (the default), disputes are no longer accepted.
    at('2030-09-03T10:01:00Z');
    expect((await dispute(absent).expect(409)).body.code).toBe('DISPUTE_WINDOW_PASSED');
    at('2030-09-03T09:59:00Z');
    await dispute(absent).expect(201);
  });
});

describe('who decides', () => {
  it('the class’s lecturer or an administrator in scope; other lecturers and students cannot see or decide it', async () => {
    at('10:25');
    await close();
    const s = c.students[0]!;
    const sent = (await dispute(s).expect(201)).body;
    await act(c.otherLecturer.auth, sent.id, 'approve', { status: 'PRESENT' }).expect(403);
    await http.get(`/api/v1/disputes/${sent.id}`).set(c.otherLecturer.auth).expect(404);
    expect((await http.get('/api/v1/disputes').set(c.otherLecturer.auth).expect(200)).body.data).toEqual([]);
    await http.get(`/api/v1/disputes/${sent.id}`).set(c.students[1]!.auth).expect(404);
    await act(c.students[1]!.auth, sent.id, 'withdraw').expect(404);
    await act(s.auth, sent.id, 'approve', { status: 'PRESENT' }).expect(403); // students cannot decide
    expect((await http.get('/api/v1/disputes').set(c.lecturer.auth).expect(200)).body.data).toHaveLength(1);
    expect((await http.get('/api/v1/disputes').set(s.auth).expect(200)).body.data).toHaveLength(1);
    // Rejecting needs a note; an administrator can decide.
    await act(c.admin.auth, sent.id, 'reject', {}).expect(400);
    const rejected = (
      await act(c.admin.auth, sent.id, 'reject', { note: 'Not seen in class (test).' }).expect(200)
    ).body;
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Not seen in class (test).' });
    expect((await recordOf(s)).status).toBe('ABSENT'); // unchanged
    expect(await prisma.attendanceCorrection.count()).toBe(0);
  });

  it('never applies to a record that changed since; the dispute stays open to be rejected or withdrawn', async () => {
    at('10:25');
    await close();
    const s = c.students[0]!;
    const sent = (await dispute(s).expect(201)).body;
    const record = await recordOf(s);
    await http
      .post(`/api/v1/attendance-records/${record.id}/correct`)
      .set(c.lecturer.auth)
      .send({ status: 'PRESENT', reason: 'Signed the paper register (test)', version: record.version })
      .expect(200);
    expect((await act(c.lecturer.auth, sent.id, 'approve', { status: 'LATE' }).expect(409)).body.code).toBe(
      'RECORD_CHANGED',
    );
    expect((await recordOf(s)).status).toBe('PRESENT'); // not overwritten
    expect((await http.get(`/api/v1/disputes/${sent.id}`).set(s.auth).expect(200)).body.status).toBe(
      'SUBMITTED',
    );
    expect((await act(s.auth, sent.id, 'withdraw').expect(200)).body.status).toBe('WITHDRAWN');
  });

  it('a withdrawn dispute can be followed by a new one', async () => {
    at('10:25');
    await close();
    const s = c.students[0]!;
    const first = (await dispute(s).expect(201)).body;
    await act(s.auth, first.id, 'withdraw').expect(200);
    expect((await act(s.auth, first.id, 'respond', { reply: 'Too late (test)' }).expect(409)).body.code).toBe(
      'NO_QUESTION',
    );
    await dispute(s).expect(201);
  });
});

describe('waiting too long', () => {
  it('tells the administrators once after 72 hours waiting for a reviewer; time waiting for the student does not count', async () => {
    at('10:25');
    await close();
    const disputes = app.get(DisputesService);
    const waiting = (await dispute(c.students[0]!).expect(201)).body;
    const asked = (await dispute(c.students[1]!).expect(201)).body;
    at('2030-08-20T12:00:00Z');
    await act(c.lecturer.auth, asked.id, 'request-info', { question: 'Who sat next to you? (test)' }).expect(
      200,
    );
    // The student answers two days later: the 72 hours start again from the answer.
    at('2030-08-22T12:00:00Z');
    await act(c.students[1]!.auth, asked.id, 'respond', {
      reply: 'A classmate, by the window (test).',
    }).expect(200);

    at('2030-08-23T10:24:00Z'); // just under 72 hours
    expect((await disputes.escalateWaiting()).escalated).toBe(0);
    at('2030-08-23T10:26:00Z');
    expect((await disputes.escalateWaiting()).escalated).toBe(1);
    expect((await disputes.escalateWaiting()).escalated).toBe(0); // once
    expect(await notificationsFor(c.admin.userId, 'DISPUTE_ESCALATED')).toHaveLength(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'disputes.escalated', entityId: waiting.id } }),
    ).toBe(1);
    // The lecturer can still decide after the hand-over.
    await act(c.lecturer.auth, waiting.id, 'approve', { status: 'PRESENT' }).expect(200);
    // The other one waited for the student for two days, so it has waited for a reviewer only since
    // the answer: not handed over yet, until 72 hours after the answer.
    expect(
      (await prisma.attendanceDispute.findUniqueOrThrow({ where: { id: asked.id } })).escalatedAt,
    ).toBeNull();
    at('2030-08-25T12:01:00Z');
    expect((await disputes.escalateWaiting()).escalated).toBe(1);
  });
});
