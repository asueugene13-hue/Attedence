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
import { ClassAlertService } from '../src/modules/class-sessions/class-alert.service.js';
import { ClassMonitorService } from '../src/modules/class-sessions/class-monitor.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data. One class, Tuesday 2030-08-20 10:00–11:30 (Africa/Accra = UTC), with ten
// enrolled students; student 1 is the section's course rep. D-13 defaults: UNCONFIRMED at +15,
// review at +30, early review at 3 students and 10%, or a rep plus 1 other student.
// The mailer records what it would send, and can be made to fail like an SMTP outage.
const sentMail: { to: string; subject: string; text: string }[] = [];
let mailFails = false;
/** The next this-many sends fail, then sending works again (an outage that recovers). */
let failNextSends = 0;
const fakeMail = {
  send: async (m: { to: string; subject: string; text: string }) => {
    if (mailFails || failNextSends > 0) {
      failNextSends = Math.max(0, failNextSends - 1);
      throw new Error('SMTP server unreachable (test)');
    }
    sentMail.push(m);
  },
  onModuleDestroy: () => undefined,
};
const clock = new FakeClock('2030-08-19T08:00:00Z');
const at = (hhmm: string) => clock.set(`2030-08-20T${hhmm}:00Z`);
let app: INestApplication;
let prisma: PrismaService;
let monitor: ClassMonitorService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let lecturer: Record<string, string>;
let otherLecturer: Record<string, string>;
let students: Record<string, string>[];
let outsider: Record<string, string>;
let studentUserIds: string[];
let sessionId: string;

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
  monitor = app.get(ClassMonitorService);
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
  mailFails = false;
  failNextSends = 0;
  await resetDatabase(prisma);
  // Cleared after the reset, which waits for the previous test's emails to finish.
  sentMail.length = 0;
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  const adminId = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
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
  const course = await prisma.course.create({
    data: { code: 'TST101', title: 'Test Course', departmentId: dept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const lecturerUser = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  const otherUser = await createUser(prisma, {
    email: 'other.lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  const profile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  await prisma.lecturerProfile.create({
    data: { userId: otherUser.id, staffNumber: 'TL2', departmentId: dept.id },
  });
  const newStudent = async (n: number, enrol: boolean) => {
    const user = await createUser(prisma, {
      email: `student${n}@example.test`,
      roles: ['STUDENT'],
      password: null,
    });
    const s = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: `99000${String(n).padStart(3, '0')}`,
        programmeId: programme.id,
        levelId: level.id,
        currentAcademicYearId: year.id,
        currentSemesterId: semester.id,
        registeredById: adminId,
      },
    });
    if (enrol) {
      await prisma.courseEnrollment.create({
        data: { studentId: s.id, offeringId: offering.id, sectionId: section.id, createdById: adminId },
      });
    }
    return { user, profile: s };
  };
  students = [];
  studentUserIds = [];
  for (let n = 1; n <= 10; n++) {
    const s = await newStudent(n, true);
    if (n === 1) {
      await prisma.courseRepAssignment.create({
        data: {
          studentId: s.profile.id,
          sectionId: section.id,
          status: 'ACTIVE',
          assignedById: adminId,
          startsAt: new Date('2030-08-15T00:00:00Z'),
        },
      });
    }
    students.push(await sessionFor(s.user.id, 'STUDENT'));
    studentUserIds.push(s.user.id);
  }
  outsider = await sessionFor((await newStudent(99, false)).user.id, 'STUDENT');
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)' },
  });
  const session = await prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: profile.id,
      classroomId: room.id,
      scheduledStart: new Date('2030-08-20T10:00:00Z'),
      scheduledEnd: new Date('2030-08-20T11:30:00Z'),
      sections: { create: [{ sectionId: section.id }] },
    },
  });
  sessionId = session.id;
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
  otherLecturer = await sessionFor(otherUser.id, 'LECTURER');
});

const status = async () => (await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).status;
const report = (auth: Record<string, string>, type = 'LECTURER_NOT_ARRIVED', note?: string) =>
  http
    .post(`/api/v1/class-sessions/${sessionId}/issue-reports`)
    .set(auth)
    .send(note ? { type, note } : { type });
const eventTypes = async () =>
  (
    await prisma.classEvent.findMany({ where: { classSessionId: sessionId }, orderBy: { occurredAt: 'asc' } })
  ).map((e) => e.type);

describe('the monitoring sweep (server time)', () => {
  it('marks a class unconfirmed at +15 and sends it to review at +30, once', async () => {
    at('10:14');
    expect(await monitor.sweep()).toEqual({ checked: 0, changed: 0, autoEnded: 0 });
    at('10:15');
    expect((await monitor.sweep()).changed).toBe(1);
    expect(await status()).toBe('UNCONFIRMED');
    expect((await monitor.sweep()).changed).toBe(0);
    at('10:30');
    await monitor.sweep();
    expect(await status()).toBe('UNDER_REVIEW');
    const review = await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(review).toMatchObject({ trigger: 'SYSTEM_ESCALATION', status: 'OPEN', isPriority: false });
    expect(await eventTypes()).toEqual(['MARKED_UNCONFIRMED', 'ESCALATED']);
    const events = await prisma.classEvent.findMany({ where: { classSessionId: sessionId } });
    expect(events.every((e) => e.actorType === 'SYSTEM')).toBe(true);
    // The lecturer can still start a class under review.
    await http.post(`/api/v1/class-sessions/${sessionId}/start`).set(lecturer).expect(200);
  });

  it('leaves a confirmed class alone, and a delay moves the checkpoints', async () => {
    at('09:00');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/delay`)
      .set(lecturer)
      .send({ minutes: 20, reason: 'Previous class overran (test)' })
      .expect(200);
    at('10:16');
    await monitor.sweep();
    expect(await status()).toBe('POSTPONED'); // expected start 10:20, so +15 is 10:35
    at('10:35');
    await monitor.sweep();
    expect(await status()).toBe('UNCONFIRMED');

    await prisma.classSession.update({
      where: { id: sessionId },
      data: { status: 'CONFIRMED', expectedStart: null },
    });
    at('11:00');
    await monitor.sweep();
    expect(await status()).toBe('CONFIRMED');
  });

  it('counts a waiting reschedule request as lecturer activity', async () => {
    at('09:00');
    await prisma.rescheduleRequest.create({
      data: {
        classSessionId: sessionId,
        requestedById: (await prisma.user.findFirstOrThrow({ where: { email: 'lecturer@example.test' } })).id,
        proposedStart: new Date('2030-08-22T10:00:00Z'),
        proposedEnd: new Date('2030-08-22T11:30:00Z'),
        proposedClassroomId: (await prisma.classroom.findFirstOrThrow()).id,
        reason: 'Waiting for approval (test)',
      },
    });
    at('10:20');
    await monitor.sweep();
    expect(await status()).toBe('SCHEDULED');
  });

  it('lets exactly one of a sweep and a lecturer’s start win', async () => {
    at('10:15');
    const [, started] = await Promise.all([
      monitor.sweep(),
      http.post(`/api/v1/class-sessions/${sessionId}/start`).set(lecturer),
    ]);
    const types = await eventTypes();
    if (started.status === 200) {
      expect(await status()).toBe('ACTIVE');
      expect(types).toEqual(['STARTED']);
    } else {
      expect(started.status).toBe(409);
      expect(await status()).toBe('UNCONFIRMED');
      expect(types).toEqual(['MARKED_UNCONFIRMED']);
      // Starting from UNCONFIRMED is still allowed.
      await http.post(`/api/v1/class-sessions/${sessionId}/start`).set(lecturer).expect(200);
    }
  });
});

describe('issue reports', () => {
  it('are taken only from the class’s students and lecturer, within the window, without duplicates', async () => {
    at('09:29');
    expect((await report(students[1]!, 'CLASS_DELAYED').expect(409)).body.code).toBe('OUTSIDE_REPORT_WINDOW');
    at('10:04');
    expect((await report(students[1]!).expect(409)).body.code).toBe('OUTSIDE_REPORT_WINDOW'); // not arrived: from +5
    at('10:05');
    const created = (await report(students[1]!, 'LECTURER_NOT_ARRIVED', 'Room is empty (test)').expect(201))
      .body;
    expect(created).toMatchObject({ reporterRole: 'STUDENT', status: 'OPEN', note: 'Room is empty (test)' });
    expect((await report(students[1]!).expect(409)).body.code).toBe('DUPLICATE_REPORT');
    expect((await report(students[0]!, 'CLASS_DELAYED').expect(201)).body.reporterRole).toBe('COURSE_REP');
    expect((await report(outsider).expect(403)).body.code).toBe('NOT_IN_CLASS');
    expect((await report(otherLecturer, 'VENUE_PROBLEM').expect(403)).body.code).toBe('NOT_YOUR_CLASS');
    await report(admin, 'OTHER').expect(403);
    expect((await report(lecturer, 'VENUE_PROBLEM').expect(201)).body.reporterRole).toBe('LECTURER');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/issue-reports`)
      .set(students[2]!)
      .send({ type: 'OTHER', note: 'x'.repeat(501) })
      .expect(400);
  });

  it('are limited to 3 per class per student', async () => {
    at('10:10');
    for (const type of ['LECTURER_NOT_ARRIVED', 'CLASS_DELAYED', 'VENUE_PROBLEM']) {
      await report(students[3]!, type).expect(201);
    }
    expect((await report(students[3]!, 'OTHER').expect(409)).body.code).toBe('REPORT_LIMIT');
  });

  it('are closed once the class is over', async () => {
    at('11:30');
    expect((await report(students[1]!, 'OTHER').expect(409)).body.code).toBe('OUTSIDE_REPORT_WINDOW');
    await prisma.classSession.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED', cancelReason: 'ILLNESS' },
    });
    at('10:10');
    expect((await report(students[1]!, 'OTHER').expect(409)).body.code).toBe('CLASS_CLOSED');
  });

  it('are shown in full to administrators; to the lecturer without student names; to students only their own', async () => {
    at('10:06');
    await report(students[1]!).expect(201);
    await report(students[2]!).expect(201);
    const forAdmin = (
      await http.get(`/api/v1/class-sessions/${sessionId}/issue-reports`).set(admin).expect(200)
    ).body.data;
    expect(forAdmin.map((r: { reporterUserId: string }) => r.reporterUserId).sort()).toEqual(
      [studentUserIds[1], studentUserIds[2]].sort(),
    );
    const forLecturer = (
      await http.get(`/api/v1/class-sessions/${sessionId}/issue-reports`).set(lecturer).expect(200)
    ).body.data;
    expect(forLecturer).toHaveLength(2);
    expect(forLecturer.every((r: { reporterUserId: string | null }) => r.reporterUserId === null)).toBe(true);
    const own = (
      await http.get(`/api/v1/class-sessions/${sessionId}/issue-reports`).set(students[1]!).expect(200)
    ).body.data;
    expect(own).toHaveLength(1);
  });
});

describe('reports as evidence (D-13)', () => {
  it('an early report nudges the lecturer once; it never changes the status by itself', async () => {
    at('10:06');
    await report(students[1]!).expect(201);
    await monitor.evaluateSession(sessionId);
    await report(students[2]!).expect(201);
    await monitor.evaluateSession(sessionId);
    expect(await status()).toBe('SCHEDULED');
    expect((await eventTypes()).filter((t) => t === 'LECTURER_PROMPTED')).toHaveLength(1);
  });

  it('3 students (and 10%) send an unconfirmed class to review before +30, through the report job', async () => {
    at('10:15');
    await monitor.sweep();
    at('10:16');
    for (const s of [students[1]!, students[2]!]) await report(s).expect(201);
    expect((await monitor.evaluateSession(sessionId)).recommendation).toBe('NONE');
    await report(students[3]!).expect(201);
    // The report queued a check of the class; wait for the background job to apply it.
    for (let i = 0; i < 200 && (await status()) !== 'UNDER_REVIEW'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await status()).toBe('UNDER_REVIEW');
    const review = await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(review.isPriority).toBe(false);
    expect(JSON.stringify(review.reasons)).toContain('3 of 10 enrolled students');
  });

  it('course rep rule: the rep plus one other student escalates early, as a priority; the rep alone does not', async () => {
    at('10:15');
    await monitor.sweep();
    at('10:16');
    await report(students[0]!).expect(201); // the rep
    expect((await monitor.evaluateSession(sessionId)).recommendation).toBe('NONE');
    expect(await status()).toBe('UNCONFIRMED');
    await report(students[4]!, 'CLASS_DELAYED').expect(201);
    await monitor.evaluateSession(sessionId);
    expect(await status()).toBe('UNDER_REVIEW');
    const review = await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(review.isPriority).toBe(true);
  });

  it('only problem reports count: wrong-room or venue reports never move a class', async () => {
    at('10:15');
    await monitor.sweep();
    at('10:16');
    for (const s of students.slice(1, 6)) await report(s, 'VENUE_PROBLEM').expect(201);
    await monitor.evaluateSession(sessionId);
    expect(await status()).toBe('UNCONFIRMED');
  });
});

describe('an administrator opening a review', () => {
  it('also opens a review record for the queue', async () => {
    await http
      .post(`/api/v1/class-sessions/${sessionId}/open-review`)
      .set(admin)
      .send({ reason: 'Lecturer phoned in sick (test)' })
      .expect(200);
    expect(await status()).toBe('UNDER_REVIEW');
    const review = await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(review).toMatchObject({ trigger: 'ADMIN_OPENED', status: 'OPEN' });
    expect(review.reasons).toEqual(['Lecturer phoned in sick (test)']);
  });
});

// ───────── Step 5b: the review queue, decisions, dismissing reports and auto-end ─────────

/** Puts the class under review the way monitoring does: unconfirmed at +15, review at +30. */
async function escalated() {
  at('10:15');
  await monitor.sweep();
  at('10:30');
  await monitor.sweep();
  expect(await status()).toBe('UNDER_REVIEW');
  return (await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } })).id;
}
const decide = (reviewId: string, body: object, auth = admin) =>
  http.post(`/api/v1/class-reviews/${reviewId}/decide`).set(auth).send(body);
const reviewRow = (id: string) => prisma.classStatusReview.findUniqueOrThrow({ where: { id } });

describe('the review queue', () => {
  it('lists open reviews within scope, with report counts, and shows one with its evidence', async () => {
    at('10:16');
    await report(students[2]!).expect(201);
    const id = await escalated();
    const list = (await http.get('/api/v1/class-reviews').set(admin).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: 'OPEN', reportCounts: { LECTURER_NOT_ARRIVED: 1 } });
    expect(list[0].classSession.id).toBe(sessionId);
    const one = (await http.get(`/api/v1/class-reviews/${id}`).set(admin).expect(200)).body;
    expect(one.reports).toHaveLength(1);
    expect(one.classSession.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['MARKED_UNCONFIRMED', 'ESCALATED']),
    );
    const otherFaculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty' } });
    const outside = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: otherFaculty.id },
      })
    ).auth;
    expect((await http.get('/api/v1/class-reviews').set(outside).expect(200)).body.data).toHaveLength(0);
    await http.get(`/api/v1/class-reviews/${id}`).set(outside).expect(403);
    await http.get('/api/v1/class-reviews').set(lecturer).expect(403);
  });
});

describe('review decisions', () => {
  it('"held" completes the class, records the note, and cannot be decided twice', async () => {
    const id = await escalated();
    await decide(id, { decision: 'CLASS_HELD' }).expect(400); // a note is required
    const done = (
      await decide(id, { decision: 'CLASS_HELD', note: 'Lecturer confirmed by phone (test)' }).expect(200)
    ).body;
    expect(done).toMatchObject({
      status: 'DECIDED',
      decision: 'CLASS_HELD',
      decisionNote: 'Lecturer confirmed by phone (test)',
    });
    expect(await status()).toBe('COMPLETED');
    expect((await eventTypes()).at(-1)).toBe('REVIEW_DECIDED');
    const again = await decide(id, { decision: 'CLASS_HELD', note: 'Again (test)' }).expect(409);
    expect(again.body.code).toBe('ALREADY_DECIDED');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'class_sessions.reviewHeld' } });
    expect(audit.reason).toBe('Lecturer confirmed by phone (test)');
  });

  it('"cancelled" records the reason code, including "absent without notice"', async () => {
    const id = await escalated();
    await decide(id, { decision: 'CANCELLED', note: 'No reason code (test)' }).expect(400);
    await decide(id, {
      decision: 'CANCELLED',
      note: 'Lecturer did not come (test)',
      reasonCode: 'LECTURER_ABSENT_NO_NOTICE',
    }).expect(200);
    expect(await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'LECTURER_ABSENT_NO_NOTICE',
    });
    expect(await reviewRow(id)).toMatchObject({
      decision: 'CANCELLED',
      decisionNote: 'Lecturer did not come (test)',
    });
  });

  it('"postponed" sets a new expected start in the future, and monitoring restarts from it', async () => {
    const id = await escalated();
    const tooShort = await decide(id, {
      decision: 'POSTPONED',
      note: 'Too short (test)',
      minutes: 20,
    }).expect(409);
    expect(tooShort.body.code).toBe('DELAY_IN_PAST');
    await decide(id, { decision: 'POSTPONED', note: 'Lecturer on the way (test)', minutes: 45 }).expect(200);
    const s = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('POSTPONED');
    expect(s.expectedStart?.toISOString()).toBe('2030-08-20T10:45:00.000Z');
    at('10:59');
    await monitor.sweep();
    expect(await status()).toBe('POSTPONED');
    at('11:00');
    await monitor.sweep();
    expect(await status()).toBe('UNCONFIRMED');
  });

  it('"no action" returns the class, to CONFIRMED if it was confirmed, only before +15', async () => {
    at('09:00');
    await http.post(`/api/v1/class-sessions/${sessionId}/confirm`).set(lecturer).expect(200);
    at('10:05');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/open-review`)
      .set(admin)
      .send({ reason: 'Timetable error reported (test)' })
      .expect(200);
    const id = (await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: sessionId } })).id;
    at('10:15');
    const late = await decide(id, { decision: 'NO_ACTION', note: 'Report was wrong (test)' }).expect(409);
    expect(late.body.code).toBe('TOO_LATE_FOR_NO_ACTION');
    at('10:10');
    await decide(id, { decision: 'NO_ACTION', note: 'Report was wrong (test)' }).expect(200);
    expect(await status()).toBe('CONFIRMED');
    expect((await reviewRow(id)).decision).toBe('NO_ACTION');
  });

  it('"rescheduled" moves the class through the reschedule flow and decides the review', async () => {
    const id = await escalated();
    const room = await prisma.classroom.findFirstOrThrow();
    await decide(id, {
      decision: 'RESCHEDULED',
      note: 'Make-up agreed with the class (test)',
      reschedule: { date: '2030-08-22', startTime: '14:00', endTime: '15:30', classroomId: room.id },
    }).expect(200);
    expect(await status()).toBe('RESCHEDULED');
    expect(
      await prisma.classSession.count({ where: { kind: 'REPLACEMENT', rescheduledFromId: sessionId } }),
    ).toBe(1);
    expect(await reviewRow(id)).toMatchObject({
      decision: 'RESCHEDULED',
      decisionNote: 'Make-up agreed with the class (test)',
    });
    expect(await prisma.rescheduleRequest.count({ where: { isDirect: true, status: 'APPROVED' } })).toBe(1);
  });

  it('a lecturer starting a class under review leaves the review open, to be decided "held"', async () => {
    const id = await escalated();
    at('10:35');
    await http.post(`/api/v1/class-sessions/${sessionId}/start`).set(lecturer).expect(200);
    expect((await reviewRow(id)).status).toBe('OPEN');
    const wrong = await decide(id, {
      decision: 'CANCELLED',
      note: 'Too late (test)',
      reasonCode: 'OTHER',
    }).expect(409);
    expect(wrong.body.code).toBe('CLASS_STARTED');
    await decide(id, { decision: 'CLASS_HELD', note: 'Started 35 minutes late (test)' }).expect(200);
    expect(await status()).toBe('ACTIVE');
    expect(await reviewRow(id)).toMatchObject({ status: 'DECIDED', decision: 'CLASS_HELD' });
  });

  it('a lecturer cancelling a class under review decides the review as cancelled', async () => {
    const id = await escalated();
    await http
      .post(`/api/v1/class-sessions/${sessionId}/cancel`)
      .set(lecturer)
      .send({ reasonCode: 'ILLNESS' })
      .expect(200);
    expect(await reviewRow(id)).toMatchObject({ status: 'DECIDED', decision: 'CANCELLED' });
    expect((await reviewRow(id)).decisionNote).toContain('lecturer');
  });
});

describe('dismissing reports', () => {
  it('stops a wrong report counting as evidence; only administrators in scope may dismiss', async () => {
    at('10:15');
    await monitor.sweep();
    at('10:16');
    const first = (await report(students[1]!).expect(201)).body;
    await report(students[2]!).expect(201);
    const dismiss = (auth: Record<string, string>) =>
      http
        .post(`/api/v1/class-issue-reports/${first.id}/dismiss`)
        .set(auth)
        .send({ note: 'Was in the wrong room (test)' });
    await dismiss(lecturer).expect(403);
    expect((await dismiss(admin).expect(200)).body.status).toBe('DISMISSED');
    expect((await dismiss(admin).expect(409)).body.code).toBe('ALREADY_DISMISSED');
    await report(students[3]!).expect(201);
    // Three reports, but one is dismissed: two do not meet the threshold.
    expect((await monitor.evaluateSession(sessionId)).recommendation).toBe('NONE');
    expect(await status()).toBe('UNCONFIRMED');
  });
});

describe('auto-end', () => {
  it('ends a class still running 30 minutes after its scheduled end', async () => {
    at('10:00');
    await http.post(`/api/v1/class-sessions/${sessionId}/start`).set(lecturer).expect(200);
    at('11:59');
    expect((await monitor.sweep()).autoEnded).toBe(0);
    at('12:00');
    expect((await monitor.sweep()).autoEnded).toBe(1);
    const s = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('COMPLETED');
    expect(s.actualEnd?.toISOString()).toBe('2030-08-20T12:00:00.000Z');
    expect((await eventTypes()).at(-1)).toBe('AUTO_ENDED');
  });
});

// ───────── Step 6: notifications ─────────

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const notificationsOf = (userId: string, category?: string) =>
  prisma.notification.findMany({ where: { userId, ...(category ? { category } : {}) } });
const userIdOf = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

describe('notifications', () => {
  it('a cancellation reaches every student, the rep, the lecturer and the administrator, in the app and by email', async () => {
    at('09:00');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/cancel`)
      .set(lecturer)
      .send({ reasonCode: 'ILLNESS' })
      .expect(200);
    const lecturerId = await userIdOf('lecturer@example.test');
    const adminId = await userIdOf('admin@example.test');
    // The alert job and the email jobs run in the background.
    await waitFor(
      async () => (await prisma.notification.count({ where: { category: 'CLASS_CANCELLED' } })) === 12,
      'alerts',
    );
    for (const id of [...studentUserIds, lecturerId, adminId]) {
      expect(await notificationsOf(id, 'CLASS_CANCELLED')).toHaveLength(1);
    }
    const toStudent = (await notificationsOf(studentUserIds[3]!, 'CLASS_CANCELLED'))[0]!;
    expect(toStudent).toMatchObject({
      priority: 'CRITICAL',
      title: 'TST101 A at Tue 20 Aug, 10:00 is cancelled',
    });
    expect(toStudent.body).toContain('illness');
    expect(toStudent.data).toMatchObject({ path: `/classes/${sessionId}` });
    await waitFor(async () => sentMail.length === 12, 'emails');
    expect(sentMail.find((m) => m.to === 'student4@example.test')?.text).toContain(`/classes/${sessionId}`);
    // Push is switched off: no push deliveries exist at all.
    expect(await prisma.notificationDelivery.count({ where: { channel: 'PUSH' } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { channel: 'EMAIL', status: 'SENT' } })).toBe(12);
  });

  it('never sends the same alert twice when its job runs again', async () => {
    at('10:15');
    await monitor.sweep();
    const event = await prisma.classEvent.findFirstOrThrow({ where: { type: 'MARKED_UNCONFIRMED' } });
    const lecturerId = await userIdOf('lecturer@example.test');
    await waitFor(
      async () => (await notificationsOf(lecturerId, 'CLASS_UNCONFIRMED')).length === 1,
      'prompt',
    );
    await app.get(ClassAlertService).alertFor(event.id);
    expect(await notificationsOf(lecturerId, 'CLASS_UNCONFIRMED')).toHaveLength(1);
    const prompt = (await notificationsOf(lecturerId, 'CLASS_UNCONFIRMED'))[0]!;
    expect(prompt.priority).toBe('HIGH');
    expect(prompt.data).toMatchObject({ actions: ['start', 'delay', 'cancel', 'reschedule', 'report'] });
    // The rep is told the lecturer has been asked; ordinary students are not.
    expect(await notificationsOf(studentUserIds[0]!, 'CLASS_UNCONFIRMED')).toHaveLength(1);
    expect(await notificationsOf(studentUserIds[5]!, 'CLASS_UNCONFIRMED')).toHaveLength(0);
  });

  it('a review alert is emailed to the administrator only if still unread after 15 minutes', async () => {
    const adminId = await userIdOf('admin@example.test');
    await escalated();
    await waitFor(async () => (await notificationsOf(adminId, 'REVIEW_OPENED')).length === 1, 'review alert');
    const alert = (await notificationsOf(adminId, 'REVIEW_OPENED'))[0]!;
    expect(alert.emailIfUnreadAt?.toISOString()).toBe('2030-08-20T10:45:00.000Z');
    const notifications = app.get(NotificationsService);
    at('10:44');
    expect(await notifications.emailUnread()).toBe(0);
    at('10:45');
    expect(await notifications.emailUnread()).toBe(1);
    expect(await notifications.emailUnread()).toBe(0); // only once
    await waitFor(async () => sentMail.some((m) => m.to === 'admin@example.test'), 'review email');
  });

  it('lets people read their notifications and choose channels, except for mandatory ones', async () => {
    at('09:00');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/cancel`)
      .set(lecturer)
      .send({ reasonCode: 'ILLNESS' })
      .expect(200);
    const me = students[4]!;
    await waitFor(
      async () => (await http.get('/api/v1/me/notifications/unread-count').set(me)).body.unread === 1,
      'unread',
    );
    const list = (await http.get('/api/v1/me/notifications?unread=true').set(me).expect(200)).body;
    expect(list.data).toHaveLength(1);
    expect(list.data[0].category).toBe('CLASS_CANCELLED');
    // Someone else's notification is not found.
    await http.post(`/api/v1/me/notifications/${list.data[0].id}/read`).set(students[5]!).expect(404);
    expect(
      (await http.post(`/api/v1/me/notifications/${list.data[0].id}/read`).set(me).expect(200)).body.unread,
    ).toBe(0);
    await http.post('/api/v1/me/notifications/read-all').set(me).expect(200);

    const prefs = (await http.get('/api/v1/me/notification-preferences').set(me).expect(200)).body.data;
    const cancelled = prefs.find((p: { category: string }) => p.category === 'CLASS_CANCELLED');
    expect(cancelled.mandatory).toBe(true);
    expect(cancelled.channels).toEqual([
      { channel: 'EMAIL', available: true, enabled: true },
      { channel: 'PUSH', available: false, enabled: true },
    ]);
    const refused = await http
      .put('/api/v1/me/notification-preferences')
      .set(me)
      .send({ category: 'CLASS_CANCELLED', channel: 'EMAIL', enabled: false })
      .expect(409);
    expect(refused.body.code).toBe('MANDATORY_CATEGORY');
    await http
      .put('/api/v1/me/notification-preferences')
      .set(lecturer)
      .send({ category: 'RESCHEDULE_DECIDED', channel: 'EMAIL', enabled: false })
      .expect(200);
  });

  it('a failed email is retried, then recorded as failed and reported to system health (scenario 23)', async () => {
    mailFails = true;
    at('09:00');
    await http
      .post(`/api/v1/class-sessions/${sessionId}/cancel`)
      .set(lecturer)
      .send({ reasonCode: 'ILLNESS' })
      .expect(200);
    await waitFor(
      async () => (await prisma.notificationDelivery.count({ where: { status: 'FAILED' } })) === 12,
      'failed deliveries',
    );
    const failed = await prisma.notificationDelivery.findFirstOrThrow({ where: { status: 'FAILED' } });
    expect(failed.attempts).toBe(5);
    expect(failed.lastError).toContain('SMTP server unreachable');
    await waitFor(
      async () =>
        (await prisma.systemEvent.count({ where: { type: 'job.dead', source: 'email/notification' } })) ===
        12,
      'system events',
    );
    // The in-app notifications were not affected.
    expect(await prisma.notification.count({ where: { category: 'CLASS_CANCELLED' } })).toBe(12);
  });
});

// ───────── Step 8: Phase 3 exit check — one simulated teaching day ─────────
// TESTING.md scenarios 13–18 and 23, in the order they happen on Tuesday 2030-08-20. The server's
// clock is moved through the day; every change goes through the real API, jobs and database.

describe('Phase 3 exit check: a simulated teaching day', () => {
  it('handles delays, cancellations, absent lecturers, rep reports, reviews, reschedules and an email outage', async () => {
    const sectionId = (await prisma.classSessionSection.findFirstOrThrow()).sectionId;
    const base = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    const room = await prisma.classroom.findFirstOrThrow();
    const otherRoom = await prisma.classroom.create({
      data: { buildingId: room.buildingId, code: 'R2', name: 'Room 2 (test)' },
    });
    const classAt = async (start: string, end: string) =>
      (
        await prisma.classSession.create({
          data: {
            kind: 'MAKEUP',
            lecturerId: base.lecturerId,
            classroomId: room.id,
            scheduledStart: new Date(`2030-08-20T${start}:00Z`),
            scheduledEnd: new Date(`2030-08-20T${end}:00Z`),
            sections: { create: [{ sectionId }] },
          },
        })
      ).id;
    const at10 = sessionId; // 10:00–11:30
    const at12 = await classAt('12:00', '13:30');
    const at14 = await classAt('14:00', '15:30');
    const at16 = await classAt('16:00', '17:30');
    const statusOf = async (id: string) =>
      (await prisma.classSession.findUniqueOrThrow({ where: { id } })).status;
    const post = (path: string, auth: Record<string, string>, body: object = {}) =>
      http.post(`/api/v1${path}`).set(auth).send(body);
    const studentNotes = (category: string) =>
      prisma.notification.count({ where: { category, userId: { in: studentUserIds } } });

    // Scenario 23: the email server is down for the first sends of the morning, then recovers.
    failNextSends = 3;

    // 09:00 — scenario 14: the lecturer reports the 10:00 class will start 20 minutes late.
    at('09:00');
    await post(`/class-sessions/${at10}/delay`, lecturer, {
      minutes: 20,
      reason: 'Stuck in traffic (test)',
    }).expect(200);
    await waitFor(async () => (await studentNotes('CLASS_DELAYED')) === 10, 'delay notices');

    // 09:30 — scenario 13: the lecturer cancels the 12:00 class; students hear at once, by email too.
    at('09:30');
    await post(`/class-sessions/${at12}/cancel`, lecturer, { reasonCode: 'OFFICIAL_DUTY' }).expect(200);
    await waitFor(async () => (await studentNotes('CLASS_CANCELLED')) === 10, 'cancellation notices');

    // 10:20 — the delayed class starts on time for its new start, so monitoring leaves it alone.
    at('10:20');
    await post(`/class-sessions/${at10}/start`, lecturer).expect(200);
    at('10:40');
    await monitor.sweep();
    expect(await statusOf(at10)).toBe('ACTIVE');

    // 14:15 — scenario 16: nobody started the 14:00 class. It becomes unconfirmed and the lecturer is asked.
    at('14:15');
    await monitor.sweep();
    expect(await statusOf(at14)).toBe('UNCONFIRMED');
    // 14:16 — three students report the lecturer has not arrived: the class goes to review early.
    at('14:16');
    for (const s of students.slice(2, 5)) {
      await post(`/class-sessions/${at14}/issue-reports`, s, { type: 'LECTURER_NOT_ARRIVED' }).expect(201);
    }
    await waitFor(async () => (await statusOf(at14)) === 'UNDER_REVIEW', 'early review');

    // 16:06 — scenario 17: the course rep reports a problem alone. The status does not change,
    // but the lecturer is nudged (and a review, if it comes, would be a priority).
    at('16:06');
    await post(`/class-sessions/${at16}/issue-reports`, students[0]!, {
      type: 'LECTURER_NOT_ARRIVED',
    }).expect(201);
    await waitFor(
      async () =>
        (await prisma.classEvent.count({ where: { classSessionId: at16, type: 'LECTURER_PROMPTED' } })) === 1,
      'rep nudge',
    );
    expect(await statusOf(at16)).toBe('SCHEDULED');

    // 16:30 — scenario 18: the administrator decides the 14:00 review: the lecturer was absent.
    at('16:30');
    const review = await prisma.classStatusReview.findFirstOrThrow({ where: { classSessionId: at14 } });
    await post(`/class-reviews/${review.id}/decide`, admin, {
      decision: 'CANCELLED',
      note: 'No word from the lecturer (test)',
      reasonCode: 'LECTURER_ABSENT_NO_NOTICE',
    }).expect(200);
    expect(await prisma.classSession.findUniqueOrThrow({ where: { id: at14 } })).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'LECTURER_ABSENT_NO_NOTICE',
    });

    // 17:00 — scenario 15: the lecturer asks to move the 16:00 class to Thursday. The first proposal
    // clashes with another class in that room and is refused; the second is approved.
    at('17:00');
    const thursday = { date: '2030-08-22', startTime: '10:00', endTime: '11:30' };
    await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: (await prisma.lecturerProfile.findFirstOrThrow({ where: { staffNumber: 'TL2' } })).id,
        classroomId: room.id,
        scheduledStart: new Date('2030-08-22T10:30:00Z'),
        scheduledEnd: new Date('2030-08-22T11:30:00Z'),
      },
    });
    const refused = await post(`/class-sessions/${at16}/reschedule-requests`, lecturer, {
      ...thursday,
      classroomId: room.id,
      reason: 'Department meeting (test)',
    }).expect(409);
    expect(refused.body.code).toBe('RESCHEDULE_BLOCKED');
    const asked = (
      await post(`/class-sessions/${at16}/reschedule-requests`, lecturer, {
        ...thursday,
        classroomId: otherRoom.id,
        reason: 'Department meeting (test)',
      }).expect(201)
    ).body;
    await post(`/reschedule-requests/${asked.id}/approve`, admin, { note: 'Room 2 is free (test)' }).expect(
      200,
    );
    expect(await statusOf(at16)).toBe('RESCHEDULED');
    await waitFor(async () => (await studentNotes('CLASS_RESCHEDULED')) === 10, 'reschedule notices');

    // 18:00 — the 10:00 class, never ended by the lecturer, was ended automatically at 12:00.
    at('18:00');
    await monitor.sweep();
    expect(await statusOf(at10)).toBe('COMPLETED');

    // Scenario 23, the end of the outage: every email went out in the end; three needed a second try,
    // and nothing was given up.
    await waitFor(
      async () => (await prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })) === 0,
      'all emails sent',
    );
    expect(
      await prisma.notificationDelivery.count({ where: { status: { in: ['FAILED', 'SUPPRESSED'] } } }),
    ).toBe(0);
    // Emails are sent in parallel, so the same email may meet the outage more than once; in total,
    // exactly three tries failed, and every email then went out.
    const emails = await prisma.notificationDelivery.findMany({ where: { channel: 'EMAIL' } });
    expect(emails.every((e) => e.status === 'SENT')).toBe(true);
    expect(emails.reduce((failed, e) => failed + e.attempts - 1, 0)).toBe(3);
    expect(await prisma.systemEvent.count({ where: { type: 'job.dead' } })).toBe(0);

    // The whole day is in each class's history, in order.
    const history = async (id: string) =>
      (
        await prisma.classEvent.findMany({ where: { classSessionId: id }, orderBy: { occurredAt: 'asc' } })
      ).map((e) => e.type);
    expect(await history(at10)).toEqual(['DELAY_REPORTED', 'STARTED', 'AUTO_ENDED']);
    expect(await history(at14)).toEqual([
      'MARKED_UNCONFIRMED',
      'ISSUE_REPORTED',
      'ISSUE_REPORTED',
      'ISSUE_REPORTED',
      'ESCALATED',
      'CANCELLED',
    ]);
    expect(await history(at16)).toEqual(['ISSUE_REPORTED', 'LECTURER_PROMPTED', 'RESCHEDULED']);
  });
});
