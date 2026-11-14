import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { buildClass, inRoom, signedCheckIn, type Student } from './attendance-fixture.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Phase 7 step 1: analytics. Obviously fake data. A week of TST101 classes (Africa/Accra = UTC):
//   Tue 20 Aug: held; student 1 present, student 2 late, student 3 absent.
//   Wed 21 Aug: held; student 1 excused, student 2 waiting for a decision, student 3 absent.
//   Thu 22 Aug: cancelled (never counts).
//   Fri 23 Aug: student 1 checked in and attendance closed, but the class has not ended (not held yet:
//   does not count).
// Plus another faculty's department: one held class with one present student; a held class whose
// attendance was reopened (does not count while open); and a student who enrolled after that class
// (their record for it does not count).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let c: Awaited<ReturnType<typeof buildClass>>;
let semesterId: string;
let otherDepartmentId: string;
let s: Student[];

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

  at('2030-08-20T09:58:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
  s = c.students;
  semesterId = (await prisma.semester.findFirstOrThrow()).id;
  const first = await prisma.classSession.findUniqueOrThrow({
    where: { id: c.classId },
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
          sections: { create: first.sections.map((x) => ({ sectionId: x.sectionId })) },
        },
      })
    ).id;
  const open = async (classId: string) =>
    (
      await http
        .post(`/api/v1/class-sessions/${classId}/attendance/open`)
        .set(c.lecturer.auth)
        .send({ startClass: true })
        .expect(201)
    ).body.id as string;
  const qr = async (id: string) =>
    (await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(c.lecturer.auth).expect(200)).body
      .token as string;
  const close = (id: string) =>
    http.post(`/api/v1/attendance-sessions/${id}/close`).set(c.lecturer.auth).send({}).expect(200);
  const end = (classId: string) =>
    http.post(`/api/v1/class-sessions/${classId}/end`).set(c.lecturer.auth).send({}).expect(200);

  // Tuesday: started 5 minutes late; present, late, absent.
  at('2030-08-20T10:05:00Z');
  const tue = await open(c.classId);
  at('2030-08-20T10:06:00Z');
  expect((await signedCheckIn(http, clock, s[0]!, inRoom(await qr(tue))).expect(200)).body.recordStatus).toBe(
    'PRESENT',
  );
  at('2030-08-20T10:21:00Z');
  expect((await signedCheckIn(http, clock, s[1]!, inRoom(await qr(tue))).expect(200)).body.recordStatus).toBe(
    'LATE',
  );
  at('2030-08-20T10:24:00Z');
  await close(tue);
  at('2030-08-20T11:30:00Z');
  await end(c.classId);

  // Wednesday: started on time; everyone absent at closing, then (fixture) one excused, one undecided.
  const wedClass = await meeting('21');
  at('2030-08-21T10:00:00Z');
  const wed = await open(wedClass);
  await close(wed);
  at('2030-08-21T11:30:00Z');
  await end(wedClass);
  await prisma.attendanceRecord.updateMany({
    where: { classSessionId: wedClass, studentId: s[0]!.profileId },
    data: { status: 'EXCUSED' },
  });
  await prisma.attendanceRecord.updateMany({
    where: { classSessionId: wedClass, studentId: s[1]!.profileId },
    data: { status: 'PENDING' },
  });

  // Thursday: cancelled by the lecturer.
  const thuClass = await meeting('22');
  at('2030-08-22T08:00:00Z');
  await http
    .post(`/api/v1/class-sessions/${thuClass}/cancel`)
    .set(c.lecturer.auth)
    .send({ reasonCode: 'OTHER', note: 'Department meeting (test)' })
    .expect(200);

  // Friday: student 1 checks in and attendance closes, but the class is still running: not held yet.
  const friClass = await meeting('23');
  at('2030-08-23T10:00:00Z');
  const fri = await open(friClass);
  at('2030-08-23T10:01:00Z');
  await signedCheckIn(http, clock, s[0]!, inRoom(await qr(fri))).expect(200);
  at('2030-08-23T10:02:00Z');
  await close(fri);

  // Another faculty and department: one held class, one present student (direct fixture rows).
  const faculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty (test)' } });
  const dept = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'OD', name: 'Other Department (test)' },
  });
  otherDepartmentId = dept.id;
  const programme = await prisma.programme.create({
    data: { departmentId: dept.id, code: 'OP', name: 'Other Programme (test)' },
  });
  const course = await prisma.course.create({
    data: { code: 'OTH201', title: 'Other Course (test)', departmentId: dept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId, status: 'OPEN' },
  });
  const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const template = await prisma.studentProfile.findUniqueOrThrow({ where: { id: s[0]!.profileId } });
  const user = await createUser(prisma, {
    email: 'other.student@example.test',
    roles: ['STUDENT'],
    password: null,
  });
  const student = await prisma.studentProfile.create({
    data: {
      userId: user.id,
      studentNumber: '99000099',
      programmeId: programme.id,
      levelId: template.levelId,
      currentAcademicYearId: template.currentAcademicYearId,
      currentSemesterId: template.currentSemesterId,
      registeredById: c.admin.userId,
    },
  });
  await prisma.courseEnrollment.create({
    data: {
      studentId: student.id,
      offeringId: offering.id,
      sectionId: section.id,
      createdById: c.admin.userId,
      enrolledAt: new Date('2030-08-16T08:00:00Z'),
    },
  });
  const cls = await prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: first.lecturerId,
      classroomId: first.classroomId,
      scheduledStart: new Date('2030-08-19T14:00:00Z'),
      scheduledEnd: new Date('2030-08-19T15:00:00Z'),
      status: 'COMPLETED',
      actualStart: new Date('2030-08-19T14:00:00Z'),
      sections: { create: [{ sectionId: section.id }] },
    },
  });
  const session = await prisma.attendanceSession.create({
    data: {
      classSessionId: cls.id,
      status: 'CLOSED',
      openedById: c.lecturer.userId,
      openedAt: new Date('2030-08-19T14:00:00Z'),
      lateAfter: new Date('2030-08-19T14:15:00Z'),
      closesAt: new Date('2030-08-19T14:20:00Z'),
      closedAt: new Date('2030-08-19T14:20:00Z'),
      closeReason: 'AUTO',
      qrSecretEnc: 'not-used-in-this-test',
      qrRotationSeconds: 15,
      verificationPolicyVersion: 1,
    },
  });
  await prisma.attendanceRecord.create({
    data: {
      classSessionId: cls.id,
      attendanceSessionId: session.id,
      studentId: student.id,
      status: 'PRESENT',
      source: 'CHECK_IN',
      checkedInAt: new Date('2030-08-19T14:01:00Z'),
    },
  });
  // A student who enrolled after the 19 August class, with a record for it: not counted.
  const lateUser = await createUser(prisma, {
    email: 'late.student@example.test',
    roles: ['STUDENT'],
    password: null,
  });
  const late = await prisma.studentProfile.create({
    data: {
      userId: lateUser.id,
      studentNumber: '99000098',
      programmeId: programme.id,
      levelId: template.levelId,
      currentAcademicYearId: template.currentAcademicYearId,
      currentSemesterId: template.currentSemesterId,
      registeredById: c.admin.userId,
    },
  });
  await prisma.courseEnrollment.create({
    data: {
      studentId: late.id,
      offeringId: offering.id,
      sectionId: section.id,
      createdById: c.admin.userId,
      enrolledAt: new Date('2030-08-20T08:00:00Z'),
    },
  });
  await prisma.attendanceRecord.create({
    data: {
      classSessionId: cls.id,
      attendanceSessionId: session.id,
      studentId: late.id,
      status: 'ABSENT',
      source: 'CLOSE',
    },
  });
  // A held class whose attendance was reopened: not counted while it is open.
  const reopened = await prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: first.lecturerId,
      classroomId: first.classroomId,
      scheduledStart: new Date('2030-08-20T14:00:00Z'),
      scheduledEnd: new Date('2030-08-20T15:00:00Z'),
      status: 'COMPLETED',
      actualStart: new Date('2030-08-20T14:00:00Z'),
      sections: { create: [{ sectionId: section.id }] },
    },
  });
  const reopenedSession = await prisma.attendanceSession.create({
    data: {
      classSessionId: reopened.id,
      status: 'OPEN',
      openedById: c.lecturer.userId,
      openedAt: new Date('2030-08-20T14:00:00Z'),
      lateAfter: new Date('2030-08-20T14:15:00Z'),
      closesAt: new Date('2030-08-20T14:20:00Z'),
      reopenedAt: new Date('2030-08-20T15:10:00Z'),
      qrSecretEnc: 'not-used-in-this-test',
      qrRotationSeconds: 15,
      verificationPolicyVersion: 1,
    },
  });
  await prisma.attendanceRecord.create({
    data: {
      classSessionId: reopened.id,
      attendanceSessionId: reopenedSession.id,
      studentId: student.id,
      status: 'PRESENT',
      source: 'CHECK_IN',
      checkedInAt: new Date('2030-08-20T14:01:00Z'),
    },
  });
  at('2030-08-24T09:00:00Z');
}, 120_000);

afterAll(async () => {
  await app.close();
});

const analytics = (auth: Record<string, string>, path: string) =>
  http.get(`/api/v1/analytics/${path}`).set(auth);

describe('attendance analytics', () => {
  it('counts only what each student’s own percentage counts, and agrees with it', async () => {
    const r = (
      await analytics(c.admin.auth, `attendance?semesterId=${semesterId}&groupBy=department`).expect(200)
    ).body;
    expect(r).toMatchObject({
      groupBy: 'department',
      lateWeight: 1,
      minimumPercent: null,
      scope: 'UNIVERSITY',
    });
    const td = r.rows.find((x: { label: string }) => x.label.startsWith('TD'));
    // Tue: P, L, A. Wed: excused, undecided, A. Thu cancelled and Fri open: nothing.
    expect(td).toMatchObject({
      students: 3,
      present: 1,
      late: 1,
      absences: 2,
      excused: 1,
      undecided: 1,
      percentage: 50,
      belowMinimum: null,
    });
    const od = r.rows.find((x: { label: string }) => x.label.startsWith('OD'));
    expect(od).toMatchObject({ students: 1, present: 1, percentage: 100 });
    expect(r.totals).toMatchObject({ present: 2, late: 1, absences: 2, percentage: 60 });

    // The same totals as the three students' own figures.
    let present = 0;
    let late = 0;
    let absences = 0;
    for (const who of s) {
      const mine = (await http.get('/api/v1/me/attendance').set(who.auth).expect(200)).body.data[0];
      present += mine.present;
      late += mine.late;
      absences += mine.absences;
    }
    expect({ present, late, absences }).toEqual({
      present: td.present,
      late: td.late,
      absences: td.absences,
    });
  });

  it('groups by programme, level, course and lecturer, naming the lecturer with their staff number', async () => {
    for (const groupBy of ['faculty', 'programme', 'level', 'course']) {
      const r = (
        await analytics(c.admin.auth, `attendance?semesterId=${semesterId}&groupBy=${groupBy}`).expect(200)
      ).body;
      expect(r.totals.present, groupBy).toBe(2);
    }
    const byLecturer = (
      await analytics(c.admin.auth, `attendance?semesterId=${semesterId}&groupBy=lecturer`).expect(200)
    ).body;
    expect(byLecturer.rows).toHaveLength(1);
    expect(byLecturer.rows[0].label).toContain('(TL1)');
  });

  it('counts students below the minimum once one is set', async () => {
    await prisma.institutionSetting.create({
      data: { key: 'attendance.minimumPercent', value: 75, updatedById: c.admin.userId },
    });
    try {
      const r = (await analytics(c.admin.auth, `attendance?semesterId=${semesterId}`).expect(200)).body;
      // Student 1: 1/1 = 100%. Student 2: 1/1 = 100% (undecided left out). Student 3: 0/2 = 0%.
      expect(r.rows.find((x: { label: string }) => x.label.startsWith('TD')).belowMinimum).toBe(1);
    } finally {
      await prisma.institutionSetting.delete({ where: { key: 'attendance.minimumPercent' } });
    }
  });

  it('stays within the administrator’s scope; lecturers and students cannot see analytics', async () => {
    const limited = await signInAs(app, prisma, 'admin.od@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: otherDepartmentId },
    });
    const r = (await analytics(limited.auth, `attendance?semesterId=${semesterId}`).expect(200)).body;
    expect(r.scope).toBe('LIMITED');
    expect(r.rows.map((x: { label: string }) => x.label)).toEqual(['OD · Other Department (test)']);
    const classes = (await analytics(limited.auth, `classes?semesterId=${semesterId}`).expect(200)).body;
    expect(classes.rows.map((x: { label: string }) => x.label)).toEqual(['OD · Other Department (test)']);
    await analytics(c.lecturer.auth, `attendance?semesterId=${semesterId}`).expect(403);
    await analytics(s[0]!.auth, `classes?semesterId=${semesterId}`).expect(403);
    // With no semester named and none active, it says so rather than guessing.
    expect((await analytics(c.admin.auth, 'attendance').expect(404)).body.code).toBe('NO_ACTIVE_SEMESTER');
  });
});

describe('class operations', () => {
  it('counts classes held, cancelled and still to come, and how late held classes started', async () => {
    const r = (await analytics(c.admin.auth, `classes?semesterId=${semesterId}&groupBy=course`).expect(200))
      .body;
    const tst = r.rows.find((x: { label: string }) => x.label.startsWith('TST101'));
    // Tue (5 minutes late) and Wed (on time) held; Thu cancelled; Fri still running.
    expect(tst).toMatchObject({
      scheduled: 4,
      held: 2,
      cancelled: 1,
      rescheduled: 0,
      stillToCome: 1,
      averageLateStartMinutes: 2.5,
    });
  });
});
