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
import { ClassMonitorService } from '../src/modules/class-sessions/class-monitor.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data. One class, Tuesday 2030-08-20 10:00–11:30 (Africa/Accra = UTC), with ten
// enrolled students; student 1 is the section's course rep. D-13 defaults: UNCONFIRMED at +15,
// review at +30, early review at 3 students and 10%, or a rep plus 1 other student.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
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
  await resetDatabase(prisma);
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
  const lecturerUser = await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
  const otherUser = await createUser(prisma, { email: 'other.lecturer@example.test', roles: ['LECTURER'] });
  const profile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  await prisma.lecturerProfile.create({
    data: { userId: otherUser.id, staffNumber: 'TL2', departmentId: dept.id },
  });
  const newStudent = async (n: number, enrol: boolean) => {
    const user = await createUser(prisma, { email: `student${n}@example.test`, roles: ['STUDENT'] });
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
    expect(await monitor.sweep()).toEqual({ checked: 0, changed: 0 });
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
