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
import { ExcusesService } from '../src/modules/requests/excuses.service.js';
import { buildClass, inRoom, signedCheckIn, type Student } from './attendance-fixture.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Excuse requests (Phase 6 step 3, decision D-22). Obviously fake data: the fixture's class on Tuesday
// 2030-08-20 10:00, a second meeting on Wednesday 21 August 10:00, and one on Thursday 22 August that
// was cancelled (Africa/Accra = UTC).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso.length === 5 ? `2030-08-20T${iso}:00Z` : iso);
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const DETAILS = 'Seen at the clinic and told to rest for two days (test).';

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let excuses: ExcusesService;
let c: Awaited<ReturnType<typeof buildClass>>;
let tuesday: string;
let wednesday: string;
let thursday: string;

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
  excuses = app.get(ExcusesService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  at('09:58');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
  tuesday = c.classId;
  const first = await prisma.classSession.findUniqueOrThrow({
    where: { id: tuesday },
    include: { sections: true },
  });
  const meeting = async (day: string) =>
    (
      await prisma.classSession.create({
        data: {
          kind: 'MAKEUP',
          lecturerId: first.lecturerId,
          classroomId: first.classroomId,
          scheduledStart: new Date(`2030-08-${day}T10:00:00Z`),
          scheduledEnd: new Date(`2030-08-${day}T11:30:00Z`),
          sections: { create: first.sections.map((s) => ({ sectionId: s.sectionId })) },
        },
      })
    ).id;
  wednesday = await meeting('21');
  thursday = await meeting('22');
  // The lecturer cancels Thursday's class (cancelled classes never count, so they are not covered).
  await http
    .post(`/api/v1/class-sessions/${thursday}/cancel`)
    .set(c.lecturer.auth)
    .send({ reasonCode: 'OTHER', note: 'Department meeting (test)' })
    .expect(200);
});

/** Attendance for a class, opened and closed by its lecturer (students who did nothing are ABSENT). */
async function takeAttendance(classId: string, open: string, present: Student[] = []) {
  at(open);
  const id = (
    await http
      .post(`/api/v1/class-sessions/${classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ startClass: true })
      .expect(201)
  ).body.id;
  for (const s of present) {
    const qr = (await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(c.lecturer.auth).expect(200)).body
      .token as string;
    await signedCheckIn(http, clock, s, inRoom(qr)).expect(200);
  }
  await http.post(`/api/v1/attendance-sessions/${id}/close`).set(c.lecturer.auth).send({}).expect(200);
}
const recordOf = (s: Student, classSessionId: string) =>
  prisma.attendanceRecord.findUnique({
    where: { classSessionId_studentId: { classSessionId, studentId: s.profileId } },
  });
const submit = (s: Student, body: object = {}) =>
  http
    .post('/api/v1/excuse-requests')
    .set(s.auth)
    .send({
      category: 'MEDICAL',
      startDate: '2030-08-20',
      endDate: '2030-08-22',
      description: DETAILS,
      ...body,
    });
const act = (auth: Record<string, string>, id: string, action: string, body: object = {}) =>
  http.post(`/api/v1/excuse-requests/${id}/${action}`).set(auth).send(body);

describe('an excuse request', () => {
  it('covers the student’s classes in the dates; an administrator asks, approves, and each record becomes excused, now or when it appears', async () => {
    const s = c.students[0]!;
    await takeAttendance(tuesday, '2030-08-20T10:00:00Z');
    expect((await recordOf(s, tuesday))!.status).toBe('ABSENT');

    at('2030-08-20T15:00:00Z');
    const sent = (await submit(s).expect(201)).body;
    expect(sent).toMatchObject({ status: 'SUBMITTED', category: 'MEDICAL', classCount: 2 });
    // The phone shows the same classes before sending (here after: Tuesday's is now absent).
    const preview = (
      await http
        .get('/api/v1/excuse-requests/covered?startDate=2030-08-20&endDate=2030-08-22')
        .set(s.auth)
        .expect(200)
    ).body.data;
    expect(
      preview.map((x: { classSessionId: string; recordStatus: string | null }) => [
        x.classSessionId,
        x.recordStatus,
      ]),
    ).toEqual([
      [tuesday, 'ABSENT'],
      [wednesday, null],
    ]);
    await http
      .get('/api/v1/excuse-requests/covered?startDate=2030-08-20&endDate=2030-08-22')
      .set(c.lecturer.auth)
      .expect(403);
    // The cancelled Thursday class is not covered; it never counts anyway.
    expect(sent.classes.map((x: { classSessionId: string }) => x.classSessionId)).toEqual([
      tuesday,
      wednesday,
    ]);
    expect(
      await prisma.notification.count({ where: { userId: c.admin.userId, category: 'EXCUSE_SUBMITTED' } }),
    ).toBe(1);
    const notice = await prisma.notification.findFirstOrThrow({ where: { category: 'EXCUSE_SUBMITTED' } });
    expect(notice.body).not.toContain('clinic'); // the details stay in the request

    // A clinic note, checked from its bytes.
    const withFile = (
      await http
        .post(`/api/v1/excuse-requests/${sent.id}/attachments`)
        .set(s.auth)
        .attach('file', FAKE_PNG, 'clinic-note.png')
        .expect(201)
    ).body;
    expect(withFile.attachments[0]).toMatchObject({ name: 'clinic-note.png', mimeType: 'image/png' });

    // The administrator asks; the student answers.
    await act(c.admin.auth, sent.id, 'request-info', { question: 'Which clinic was it? (test)' }).expect(200);
    await act(s.auth, sent.id, 'respond', { reply: 'The university clinic (test).' }).expect(200);

    // Approve both classes. Tuesday's absence is excused at once; Wednesday has no record yet.
    at('2030-08-20T16:00:00Z');
    const approved = (
      await act(c.admin.auth, sent.id, 'approve', { classSessionIds: [tuesday, wednesday] }).expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'APPROVED', excusedCount: 2 });
    expect((await recordOf(s, tuesday))!.status).toBe('EXCUSED');
    expect(await recordOf(s, wednesday)).toBeNull();
    const correction = await prisma.attendanceCorrection.findFirstOrThrow({
      where: { record: { classSessionId: tuesday, studentId: s.profileId } },
    });
    expect(correction).toMatchObject({
      fromStatus: 'ABSENT',
      toStatus: 'EXCUSED',
      source: 'EXCUSE',
      sourceId: sent.id,
      correctedById: c.admin.userId,
    });
    // What the lecturer can see in the record's history says nothing about the reason (D-22).
    const record = (await recordOf(s, tuesday))!;
    const history = JSON.stringify(
      (await http.get(`/api/v1/attendance-records/${record.id}/history`).set(c.lecturer.auth).expect(200))
        .body,
    );
    expect(history).toContain('EXCUSED');
    expect(history).not.toMatch(/clinic|MEDICAL|medical/);
    expect(await prisma.notification.count({ where: { userId: s.userId, category: 'EXCUSE_DECIDED' } })).toBe(
      1,
    );

    // Wednesday's class happens; attendance closes with the student absent; the excuse is applied.
    await takeAttendance(wednesday, '2030-08-21T10:00:00Z');
    expect((await recordOf(s, wednesday))!.status).toBe('ABSENT');
    expect((await excuses.applyApproved()).applied).toBe(1);
    expect((await recordOf(s, wednesday))!.status).toBe('EXCUSED');
    expect((await excuses.applyApproved()).applied).toBe(0); // once
    expect(await prisma.auditLog.count({ where: { action: 'excuses.applied', entityId: sent.id } })).toBe(1);

    // Excused classes leave the student's total.
    at('2030-08-21T12:00:00Z');
    for (const classId of [tuesday, wednesday]) {
      await http.post(`/api/v1/class-sessions/${classId}/end`).set(c.lecturer.auth).send({}).expect(200);
    }
    const mine = (await http.get('/api/v1/me/attendance').set(s.auth).expect(200)).body.data[0];
    expect(mine.excused).toBe(2);
    expect(mine.absences).toBe(0);

    // The conversation and files are history.
    await expect(prisma.excuseMessage.updateMany({ data: { body: 'edited' } })).rejects.toThrow();
    await expect(prisma.excuseAttachment.deleteMany({})).rejects.toThrow();
  });

  it('excuses only the classes the administrator chose, and never changes a class the student attended', async () => {
    const s = c.students[1]!;
    await takeAttendance(tuesday, '2030-08-20T10:00:00Z', [s]);
    expect((await recordOf(s, tuesday))!.status).toBe('PRESENT');
    at('2030-08-20T15:00:00Z');
    const sent = (await submit(s, { category: 'OFFICIAL_UNIVERSITY_DUTY' }).expect(201)).body;
    await act(c.admin.auth, sent.id, 'approve', { classSessionIds: [tuesday] }).expect(200);
    expect((await recordOf(s, tuesday))!.status).toBe('PRESENT'); // attended: stays present
    await takeAttendance(wednesday, '2030-08-21T10:00:00Z');
    expect((await excuses.applyApproved()).applied).toBe(0);
    expect((await recordOf(s, wednesday))!.status).toBe('ABSENT'); // not chosen: stays absent
    const view = (await http.get(`/api/v1/excuse-requests/${sent.id}`).set(s.auth).expect(200)).body;
    expect(view.classes.map((x: { included: boolean }) => x.included)).toEqual([true, false]);
    await act(c.admin.auth, sent.id, 'approve', { classSessionIds: [wednesday] }).expect(409);
  });
});

describe('who sees and decides', () => {
  it('only administrators in the student’s scope; never lecturers; other students are told it does not exist', async () => {
    at('2030-08-20T15:00:00Z');
    const s = c.students[0]!;
    const sent = (await submit(s).expect(201)).body;
    for (const call of [
      http.get('/api/v1/excuse-requests').set(c.lecturer.auth),
      http.get(`/api/v1/excuse-requests/${sent.id}`).set(c.lecturer.auth),
      act(c.lecturer.auth, sent.id, 'approve', { classSessionIds: [tuesday] }),
    ]) {
      expect((await call.expect(403)).body.code).toBe('ADMINISTRATORS_ONLY');
    }
    await http.get(`/api/v1/excuse-requests/${sent.id}`).set(c.students[1]!.auth).expect(404);
    await act(s.auth, sent.id, 'approve', { classSessionIds: [tuesday] }).expect(403);

    // An administrator for another department does not see it.
    const faculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty (test)' } });
    const dept = await prisma.department.create({
      data: { facultyId: faculty.id, code: 'OD', name: 'Other Department (test)' },
    });
    const elsewhere = await signInAs(app, prisma, 'admin.elsewhere@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: dept.id },
    });
    expect((await http.get('/api/v1/excuse-requests').set(elsewhere.auth).expect(200)).body.data).toEqual([]);
    await http.get(`/api/v1/excuse-requests/${sent.id}`).set(elsewhere.auth).expect(404);
    await act(elsewhere.auth, sent.id, 'reject', { note: 'Not mine to decide (test).' }).expect(404);

    // Rejecting needs a note; the records stay; the classes can be asked for again.
    await act(c.admin.auth, sent.id, 'reject', {}).expect(400);
    expect(
      (await act(c.admin.auth, sent.id, 'reject', { note: 'No supporting note (test).' }).expect(200)).body
        .status,
    ).toBe('REJECTED');
    expect(await prisma.attendanceCorrection.count()).toBe(0);
    await submit(s).expect(201);
  });
});

describe('what can be asked for', () => {
  it('classes in the dates, once, until 14 days after the last one', async () => {
    const s = c.students[0]!;
    at('2030-08-20T15:00:00Z');
    expect((await submit(s, { startDate: '2030-08-25', endDate: '2030-08-26' }).expect(409)).body.code).toBe(
      'NO_CLASSES',
    );
    await submit(s, { startDate: '2030-08-01', endDate: '2030-09-05' }).expect(400); // more than 31 days
    await submit(s, { startDate: '2030-08-22', endDate: '2030-08-20' }).expect(400);
    await submit(s, { description: 'short' }).expect(400);
    expect((await submit(s, { classSessionIds: [thursday] }).expect(400)).body.code).toBe('NOT_COVERED');
    // Ask for Tuesday only, then for both days: Tuesday is already asked for.
    const first = (await submit(s, { classSessionIds: [tuesday] }).expect(201)).body;
    expect((await submit(s).expect(409)).body.code).toBe('ALREADY_REQUESTED');
    await submit(s, { classSessionIds: [wednesday] }).expect(201);
    await act(s.auth, first.id, 'withdraw').expect(200);
    await submit(s, { classSessionIds: [tuesday] }).expect(201);
    // 14 days (the default) after the last class covered, requests are no longer accepted.
    const other = c.students[1]!;
    at('2030-09-04T10:01:00Z');
    expect((await submit(other).expect(409)).body.code).toBe('EXCUSE_WINDOW_PASSED');
    at('2030-09-04T09:59:00Z');
    await submit(other).expect(201);
    await http.post('/api/v1/excuse-requests').set(c.lecturer.auth).send({}).expect(403);
  });
});
