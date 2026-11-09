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
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data. The class meets Tuesday 2030-08-20, 10:00–11:30 (Africa/Accra = UTC). The
// lecturer asks to move it to Thursday 2030-08-22, 14:00–15:30, in room R2.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-19T08:00:00Z');
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let lecturer: Record<string, string>;
let otherLecturer: Record<string, string>;
let student: Record<string, string>;
let sessionId: string;
let ids: Record<
  'faculty' | 'otherFaculty' | 'lecturer' | 'otherLecturer' | 'room1' | 'room2' | 'section' | 'otherSection',
  string
>;

const PROPOSAL = { date: '2030-08-22', startTime: '14:00', endTime: '15:30' };
const NEW_START = '2030-08-22T14:00:00.000Z';

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
});

async function sessionFor(userId: string, role: 'LECTURER' | 'STUDENT') {
  const { SessionService } = await import('../src/modules/auth/session.service.js');
  const { TokenService } = await import('../src/modules/auth/token.service.js');
  const { session } = await app.get(SessionService).create({
    userId,
    client: 'MOBILE',
    role,
    mfaVerified: false,
    context: { requestId: undefined, ip: undefined, userAgent: undefined },
  });
  const { token } = await app.get(TokenService).signAccess({ userId, sessionId: session.id, role });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  clock.set('2030-08-19T08:00:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  const adminId = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const otherFaculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty' } });
  const dept = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
  });
  const programme = await prisma.programme.create({
    data: { departmentId: dept.id, code: 'TP', name: 'Test Programme' },
  });
  const level = await prisma.academicLevel.create({
    data: { code: 'L1', name: 'Level One (test)', sortOrder: 1 },
  });
  const year = await prisma.academicYear.create({
    data: { label: 'TEST-2030', startDate: new Date('2030-08-01'), endDate: new Date('2031-07-31') },
  });
  const semester = await prisma.semester.create({
    data: {
      academicYearId: year.id,
      number: 1,
      name: 'First (test)',
      startDate: new Date('2030-08-15'),
      endDate: new Date('2030-12-20'),
    },
  });
  const sectionOf = async (code: string) => {
    const course = await prisma.course.create({
      data: { code, title: `Test Course ${code}`, departmentId: dept.id },
    });
    const offering = await prisma.courseOffering.create({
      data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
    });
    const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
    return { offering, section };
  };
  const own = await sectionOf('TST101');
  const other = await sectionOf('TST102');
  const lecturerUser = await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
  const otherUser = await createUser(prisma, { email: 'other.lecturer@example.test', roles: ['LECTURER'] });
  const studentUser = await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
  const profile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  const otherProfile = await prisma.lecturerProfile.create({
    data: { userId: otherUser.id, staffNumber: 'TL2', departmentId: dept.id },
  });
  // Two students in the class; one of them also takes TST102.
  for (const [n, sections] of [
    ['1', [own, other]],
    ['2', [own]],
  ] as const) {
    const user =
      n === '1'
        ? studentUser
        : await createUser(prisma, { email: `student${n}@example.test`, roles: ['STUDENT'] });
    const s = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: `9900000${n}`,
        programmeId: programme.id,
        levelId: level.id,
        currentAcademicYearId: year.id,
        currentSemesterId: semester.id,
        registeredById: adminId,
      },
    });
    for (const x of sections) {
      await prisma.courseEnrollment.create({
        data: { studentId: s.id, offeringId: x.offering.id, sectionId: x.section.id, createdById: adminId },
      });
    }
  }
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room1 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)' },
  });
  const room2 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R2', name: 'Room 2 (test)', capacity: 1 },
  });
  const session = await prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: profile.id,
      classroomId: room1.id,
      scheduledStart: new Date('2030-08-20T10:00:00Z'),
      scheduledEnd: new Date('2030-08-20T11:30:00Z'),
      sections: { create: [{ sectionId: own.section.id }] },
    },
  });
  sessionId = session.id;
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
  otherLecturer = await sessionFor(otherUser.id, 'LECTURER');
  student = await sessionFor(studentUser.id, 'STUDENT');
  ids = {
    faculty: faculty.id,
    otherFaculty: otherFaculty.id,
    lecturer: profile.id,
    otherLecturer: otherProfile.id,
    room1: room1.id,
    room2: room2.id,
    section: own.section.id,
    otherSection: other.section.id,
  };
});

const post = (path: string, auth: Record<string, string>, body: object = {}) =>
  http.post(`/api/v1${path}`).set(auth).send(body);
const ask = (auth: Record<string, string>, overrides: object = {}) =>
  post(`/class-sessions/${sessionId}/reschedule-requests`, auth, {
    ...PROPOSAL,
    classroomId: ids.room2,
    reason: 'Department meeting at that time (test)',
    ...overrides,
  });
/** Another live class at the proposed time, for clash checks. */
const otherClass = (data: {
  lecturerId?: string;
  classroomId?: string;
  sectionId?: string;
  start?: string;
}) =>
  prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: data.lecturerId ?? ids.otherLecturer,
      classroomId: data.classroomId ?? ids.room1,
      scheduledStart: new Date(data.start ?? '2030-08-22T14:30:00Z'),
      scheduledEnd: new Date(new Date(data.start ?? '2030-08-22T14:30:00Z').getTime() + 60 * 60_000),
      sections: data.sectionId ? { create: [{ sectionId: data.sectionId }] } : undefined,
    },
  });

describe('a lecturer’s reschedule request (D-11)', () => {
  it('is approved by an administrator: a replacement class is created and the original kept', async () => {
    const created = (await ask(lecturer).expect(201)).body;
    expect(created).toMatchObject({ status: 'PENDING', isDirect: false, proposedStart: NEW_START });
    // Nothing changes until an administrator approves.
    expect((await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe(
      'SCHEDULED',
    );

    const seen = (await http.get(`/api/v1/reschedule-requests/${created.id}`).set(admin).expect(200)).body;
    expect(seen.check.blockers).toEqual([]);
    const approved = (
      await post(`/reschedule-requests/${created.id}/approve`, admin, {
        note: 'Room confirmed (test)',
      }).expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'APPROVED', decisionNote: 'Room confirmed (test)' });
    expect(approved.replacementSession).toMatchObject({
      kind: 'REPLACEMENT',
      status: 'SCHEDULED',
      rescheduledFromId: sessionId,
      classroom: { id: ids.room2 },
      sections: [{ id: ids.section }],
    });
    expect(new Date(approved.replacementSession.scheduledStart).toISOString()).toBe(NEW_START);

    const original = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(original.status).toBe('RESCHEDULED');
    const event = await prisma.classEvent.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(event).toMatchObject({ type: 'RESCHEDULED', fromStatus: 'SCHEDULED', toStatus: 'RESCHEDULED' });
    expect(event.payload).toMatchObject({
      as: 'ADMIN',
      replacementSessionId: approved.replacementSession.id,
      newStart: NEW_START,
    });
    const actions = (await prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'reschedule_requests.created',
        'class_sessions.reschedule',
        'reschedule_requests.approved',
      ]),
    );
    // A decided request cannot be decided again.
    await post(`/reschedule-requests/${created.id}/reject`, admin, { note: 'Changed my mind (test)' }).expect(
      409,
    );
  });

  it('is refused when the room is taken, the lecturer is busy, or the time has passed', async () => {
    await otherClass({ classroomId: ids.room2 });
    const blocked = await ask(lecturer).expect(409);
    expect(blocked.body.code).toBe('RESCHEDULE_BLOCKED');
    expect(blocked.body.errors.blockers.map((b: { code: string }) => b.code)).toEqual(['ROOM_TAKEN']);

    await otherClass({ lecturerId: ids.lecturer, start: '2030-08-23T09:00:00Z' });
    const busy = await ask(lecturer, { date: '2030-08-23', startTime: '09:30', endTime: '10:30' }).expect(
      409,
    );
    expect(busy.body.errors.blockers.map((b: { code: string }) => b.code)).toEqual(['LECTURER_BUSY']);

    const past = await ask(lecturer, { date: '2030-08-18' }).expect(409);
    expect(past.body.errors.blockers.map((b: { code: string }) => b.code)).toEqual(['IN_THE_PAST']);
    expect(await prisma.rescheduleRequest.count()).toBe(0);
  });

  it('warns, without refusing, about students’ other classes, days without classes and small rooms', async () => {
    await otherClass({ sectionId: ids.otherSection });
    await prisma.calendarException.create({
      data: {
        type: 'OTHER',
        name: 'Sports day (fake)',
        startDate: new Date('2030-08-22'),
        endDate: new Date('2030-08-22'),
        createdById: (await prisma.user.findFirstOrThrow()).id,
      },
    });
    const check = (
      await post(`/class-sessions/${sessionId}/reschedule-check`, lecturer, {
        ...PROPOSAL,
        classroomId: ids.room2,
      }).expect(200)
    ).body;
    expect(check.blockers).toEqual([]);
    expect(check.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
      'NO_CLASS_DAY',
      'ROOM_TOO_SMALL',
      'STUDENT_CLASH',
    ]);
    expect(check.warnings.find((w: { code: string }) => w.code === 'STUDENT_CLASH').students).toBe(1);
    const created = (await ask(lecturer).expect(201)).body;
    expect(created.warnings).toHaveLength(3);
  });

  it('can be made only by the class’s own lecturer, once at a time, and withdrawn only by them', async () => {
    await ask(otherLecturer).expect(403);
    await ask(student).expect(403);
    expect((await ask(admin).expect(403)).body.code).toBe('PERMISSION_DENIED');
    const first = (await ask(lecturer).expect(201)).body;
    expect((await ask(lecturer).expect(409)).body.code).toBe('REQUEST_PENDING');

    await post(`/reschedule-requests/${first.id}/withdraw`, otherLecturer).expect(403);
    expect((await post(`/reschedule-requests/${first.id}/withdraw`, lecturer).expect(200)).body.status).toBe(
      'WITHDRAWN',
    );
    // Withdrawn, so a new request is allowed; this one is rejected with a note.
    const second = (await ask(lecturer).expect(201)).body;
    await post(`/reschedule-requests/${second.id}/reject`, admin, {}).expect(400);
    const rejected = (
      await post(`/reschedule-requests/${second.id}/reject`, admin, { note: 'Exam week (test)' }).expect(200)
    ).body;
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Exam week (test)' });
    expect((await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe(
      'SCHEDULED',
    );
  });

  it('lists requests: lecturers see their own, administrators those within their scope', async () => {
    await ask(lecturer).expect(201);
    const mine = (await http.get('/api/v1/reschedule-requests').set(lecturer).expect(200)).body.data;
    expect(mine).toHaveLength(1);
    expect(
      (await http.get('/api/v1/reschedule-requests').set(otherLecturer).expect(200)).body.data,
    ).toHaveLength(0);
    expect(
      (await http.get('/api/v1/reschedule-requests?status=PENDING').set(admin).expect(200)).body.data,
    ).toHaveLength(1);
    const outside = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;
    expect((await http.get('/api/v1/reschedule-requests').set(outside).expect(200)).body.data).toHaveLength(
      0,
    );
    await post(`/reschedule-requests/${mine[0].id}/approve`, outside).expect(403);
    await http.get('/api/v1/reschedule-requests').set(student).expect(403);
  });
});

describe('approval safety', () => {
  it('checks again at approval: a room booked since the request blocks it', async () => {
    const created = (await ask(lecturer).expect(201)).body;
    await otherClass({ classroomId: ids.room2 });
    expect((await post(`/reschedule-requests/${created.id}/approve`, admin).expect(409)).body.code).toBe(
      'RESCHEDULE_BLOCKED',
    );
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(
      'PENDING',
    );
  });

  it('refuses when the class was cancelled after the request', async () => {
    const created = (await ask(lecturer).expect(201)).body;
    await post(`/class-sessions/${sessionId}/cancel`, lecturer, { reasonCode: 'ILLNESS' }).expect(200);
    expect((await post(`/reschedule-requests/${created.id}/approve`, admin).expect(409)).body.code).toBe(
      'TRANSITION_NOT_ALLOWED',
    );
    expect(await prisma.classSession.count({ where: { kind: 'REPLACEMENT' } })).toBe(0);
  });

  it('lets only one of two approvals into the same room and time through', async () => {
    // A second class, of the other lecturer, whose request asks for the same room and time.
    const second = await otherClass({ start: '2030-08-21T10:00:00Z', sectionId: ids.otherSection });
    const first = (await ask(lecturer).expect(201)).body;
    const theirs = (
      await post(`/class-sessions/${second.id}/reschedule-requests`, otherLecturer, {
        ...PROPOSAL,
        classroomId: ids.room2,
        reason: 'Clashes with a seminar (test)',
      }).expect(201)
    ).body;
    const results = await Promise.all([
      post(`/reschedule-requests/${first.id}/approve`, admin),
      post(`/reschedule-requests/${theirs.id}/approve`, admin),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.classSession.count({ where: { kind: 'REPLACEMENT' } })).toBe(1);
    expect(await prisma.rescheduleRequest.count({ where: { status: 'APPROVED' } })).toBe(1);
  });
});

describe('a direct reschedule by an administrator', () => {
  it('needs a reason, closes a waiting request, and is recorded as a direct reschedule', async () => {
    const waiting = (await ask(lecturer).expect(201)).body;
    const direct = (path: string, body: object, auth = admin) => post(path, auth, body);
    await direct(`/class-sessions/${sessionId}/reschedule`, { ...PROPOSAL, classroomId: ids.room1 }).expect(
      400,
    );
    await direct(
      `/class-sessions/${sessionId}/reschedule`,
      {
        ...PROPOSAL,
        classroomId: ids.room1,
        reason: 'Lecturer asked by phone (test)',
      },
      lecturer,
    ).expect(403);
    const done = (
      await direct(`/class-sessions/${sessionId}/reschedule`, {
        ...PROPOSAL,
        classroomId: ids.room1,
        reason: 'Building closed for repairs (test)',
      }).expect(201)
    ).body;
    expect(done).toMatchObject({
      status: 'APPROVED',
      isDirect: true,
      reason: 'Building closed for repairs (test)',
    });
    expect(done.replacementSession.classroom.id).toBe(ids.room1);
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(
      'REJECTED',
    );
    expect((await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe(
      'RESCHEDULED',
    );
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'reschedule_requests.direct' } });
    expect(audit.reason).toBe('Building closed for repairs (test)');
    // A rescheduled class is final: it cannot be moved again (its replacement can).
    await direct(`/class-sessions/${sessionId}/reschedule`, {
      ...PROPOSAL,
      date: '2030-08-23',
      classroomId: ids.room1,
      reason: 'Second move (test)',
    }).expect(409);
  });

  it('is limited to the administrator’s scope', async () => {
    const outside = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;
    await post(`/class-sessions/${sessionId}/reschedule`, outside, {
      ...PROPOSAL,
      classroomId: ids.room1,
      reason: 'Out of scope (test)',
    }).expect(403);
  });
});
