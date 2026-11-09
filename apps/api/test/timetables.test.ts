import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data: TEST-* labels, TST/OTH course codes, example.test people (CLAUDE.md rule 2).
// The semester runs Thursday 15 August to Friday 20 December 2030; 2030-08-20 is a Tuesday.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let ids: Record<
  | 'faculty'
  | 'otherFaculty'
  | 'semester'
  | 'sectionA'
  | 'sectionB'
  | 'sectionX'
  | 'lecturer1'
  | 'lecturer2'
  | 'room1'
  | 'room2',
  string
>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
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

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  const actor = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const otherFaculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty' } });
  const dept = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
  });
  const otherDept = await prisma.department.create({
    data: { facultyId: otherFaculty.id, code: 'OD', name: 'Other Department' },
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
  const otherCourse = await prisma.course.create({
    data: { code: 'OTH201', title: 'Other Course', departmentId: otherDept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const otherOffering = await prisma.courseOffering.create({
    data: { courseId: otherCourse.id, semesterId: semester.id, status: 'OPEN' },
  });
  const sectionA = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const sectionB = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'B' } });
  const sectionX = await prisma.courseSection.create({ data: { offeringId: otherOffering.id, code: 'X' } });
  const lecturerUser1 = await createUser(prisma, { email: 'lecturer.one@example.test', roles: ['LECTURER'] });
  const lecturerUser2 = await createUser(prisma, { email: 'lecturer.two@example.test', roles: ['LECTURER'] });
  const lecturer1 = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser1.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  const lecturer2 = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser2.id, staffNumber: 'TL2', departmentId: otherDept.id },
  });
  for (const [lecturerId, sectionId, isPrimary] of [
    [lecturer1.id, sectionA.id, true],
    [lecturer1.id, sectionB.id, true],
    [lecturer2.id, sectionX.id, true],
  ] as const) {
    await prisma.lecturerAssignment.create({
      data: { lecturerId, sectionId, isPrimary, assignedById: actor },
    });
  }
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room1 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)', capacity: 2 },
  });
  const room2 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R2', name: 'Room 2 (test)', capacity: 100 },
  });
  // Three students in section A, one of whom is also in section X (for a student-clash warning).
  for (const n of [1, 2, 3]) {
    const user = await createUser(prisma, { email: `student${n}@example.test`, roles: ['STUDENT'] });
    const student = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: String(99000000 + n),
        programmeId: programme.id,
        levelId: level.id,
        currentAcademicYearId: year.id,
        currentSemesterId: semester.id,
        registeredById: actor,
      },
    });
    const sections = n === 2 ? [sectionA, sectionX] : [sectionA];
    for (const s of sections) {
      await prisma.courseEnrollment.create({
        data: { studentId: student.id, offeringId: s.offeringId, sectionId: s.id, createdById: actor },
      });
    }
  }
  ids = {
    faculty: faculty.id,
    otherFaculty: otherFaculty.id,
    semester: semester.id,
    sectionA: sectionA.id,
    sectionB: sectionB.id,
    sectionX: sectionX.id,
    lecturer1: lecturer1.id,
    lecturer2: lecturer2.id,
    room1: room1.id,
    room2: room2.id,
  };
});

const post = (path: string, body: object = {}, auth = admin) =>
  http.post(`/api/v1${path}`).set(auth).send(body);
const get = (path: string, auth = admin) => http.get(`/api/v1${path}`).set(auth);
const draft = async () =>
  (await post('/timetables', { semesterId: ids.semester, name: 'Semester 1 (test)' }).expect(201)).body;
const tuesdayEntry = (overrides: object = {}) => ({
  sectionIds: [ids.sectionA],
  lecturerId: ids.lecturer1,
  classroomId: ids.room2,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:30',
  ...overrides,
});

describe('drafts', () => {
  it('creates one draft per semester and refuses a second', async () => {
    const timetable = await draft();
    expect(timetable).toMatchObject({
      status: 'DRAFT',
      version: 1,
      entries: [],
      semester: { startDate: '2030-08-15' },
    });
    expect(
      (await post('/timetables', { semesterId: ids.semester, name: 'Another (test)' }).expect(409)).body.code,
    ).toBe('DRAFT_EXISTS');
  });

  it('needs university-wide scope to create a timetable', async () => {
    const scoped = (
      await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.faculty },
      })
    ).auth;
    await post('/timetables', { semesterId: ids.semester, name: 'Scoped (test)' }, scoped).expect(403);
    const registrar = (await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR'])).auth;
    await post('/timetables', { semesterId: ids.semester, name: 'Registrar (test)' }, registrar).expect(403);
  });
});

describe('entries and recurrence', () => {
  it('adds a weekly entry with the semester dates by default', async () => {
    const t = await draft();
    const entry = (await post(`/timetables/${t.id}/entries`, tuesdayEntry()).expect(201)).body;
    expect(entry).toMatchObject({
      recurrence: 'WEEKLY',
      dayOfWeek: 2,
      startTime: '10:00',
      endTime: '11:30',
      effectiveFrom: '2030-08-15',
      effectiveTo: '2030-12-20',
      sections: [{ code: 'A', course: { code: 'TST101' } }],
      classroom: { code: 'R2' },
    });
    const dates = (await get(`/timetable-entries/${entry.id}/dates`).expect(200)).body;
    expect(dates.dates).toHaveLength(18);
    expect(dates.dates[0]).toBe('2030-08-20');
  });

  it('supports every other week, selected weeks and one-time classes', async () => {
    const t = await draft();
    const everyOther = (
      await post(
        `/timetables/${t.id}/entries`,
        tuesdayEntry({ recurrence: 'EVERY_OTHER_WEEK', effectiveTo: '2030-09-10' }),
      ).expect(201)
    ).body;
    expect((await get(`/timetable-entries/${everyOther.id}/dates`)).body.dates).toEqual([
      '2030-08-20',
      '2030-09-03',
    ]);
    const selected = (
      await post(
        `/timetables/${t.id}/entries`,
        tuesdayEntry({
          recurrence: 'SELECTED_WEEKS',
          selectedWeeks: [4, 2],
          startTime: '14:00',
          endTime: '15:00',
        }),
      ).expect(201)
    ).body;
    expect(selected.selectedWeeks).toEqual([2, 4]);
    expect((await get(`/timetable-entries/${selected.id}/dates`)).body.dates).toEqual([
      '2030-08-20',
      '2030-09-03',
    ]);
    const once = (
      await post(
        `/timetables/${t.id}/entries`,
        tuesdayEntry({
          recurrence: 'ONCE',
          dayOfWeek: undefined,
          date: '2030-10-02',
          startTime: '08:00',
          endTime: '09:00',
        }),
      ).expect(201)
    ).body;
    expect(once).toMatchObject({ dayOfWeek: 3, effectiveFrom: '2030-10-02', effectiveTo: '2030-10-02' });
  });

  it('refuses entries that cannot work, with a clear reason', async () => {
    const t = await draft();
    const add = (overrides: object) => post(`/timetables/${t.id}/entries`, tuesdayEntry(overrides));
    expect((await add({ lecturerId: ids.lecturer2 }).expect(400)).body.code).toBe('LECTURER_NOT_ASSIGNED');
    expect((await add({ effectiveFrom: '2030-08-01' }).expect(400)).body.code).toBe('OUTSIDE_SEMESTER');
    expect(
      (await add({ effectiveFrom: '2030-08-21', effectiveTo: '2030-08-25' }).expect(400)).body.code,
    ).toBe('NO_MEETINGS');
    expect((await add({ recurrence: 'SELECTED_WEEKS', selectedWeeks: [25] }).expect(400)).body.code).toBe(
      'INVALID_WEEK',
    );
    await add({ endTime: '09:00' }).expect(400);
    await add({ dayOfWeek: undefined }).expect(400);
    await add({ recurrence: 'ONCE', dayOfWeek: undefined }).expect(400);
  });

  it('skips holidays and the entry’s own exceptions, with reasons', async () => {
    const creator = await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } });
    await prisma.calendarException.create({
      data: {
        type: 'PUBLIC_HOLIDAY',
        name: 'Test Holiday',
        startDate: new Date('2030-09-03'),
        endDate: new Date('2030-09-03'),
        createdById: creator.id,
      },
    });
    const t = await draft();
    const entry = (
      await post(`/timetables/${t.id}/entries`, tuesdayEntry({ effectiveTo: '2030-09-10' })).expect(201)
    ).body;
    await post(`/timetable-entries/${entry.id}/exceptions`, {
      date: '2030-08-28',
      reason: 'Not a Tuesday (test)',
    }).expect(400);
    await post(`/timetable-entries/${entry.id}/exceptions`, {
      date: '2030-08-27',
      reason: 'Lecturer away (test)',
    }).expect(201);
    expect(
      (
        await post(`/timetable-entries/${entry.id}/exceptions`, {
          date: '2030-08-27',
          reason: 'Again (test)',
        }).expect(409)
      ).body.code,
    ).toBe('ALREADY_EXCEPTED');
    const dates = (await get(`/timetable-entries/${entry.id}/dates`)).body;
    expect(dates.dates).toEqual(['2030-08-20', '2030-09-10']);
    expect(dates.skipped).toEqual([
      { date: '2030-08-27', why: 'Lecturer away (test)' },
      { date: '2030-09-03', why: 'Test Holiday' },
    ]);
  });

  it('limits a scoped administrator to sections in their scope', async () => {
    const t = await draft();
    const otherScope = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;
    await post(`/timetables/${t.id}/entries`, tuesdayEntry(), otherScope).expect(403);
  });
});

describe('clash check and publishing', () => {
  it('blocks publishing while rooms, lecturers or sections clash, and lists warnings', async () => {
    const t = await draft();
    const a = (
      await post(`/timetables/${t.id}/entries`, tuesdayEntry({ classroomId: ids.room1 })).expect(201)
    ).body;
    // Another lecturer's class in the same room, overlapping: room clash; student 2 is in both sections.
    const x = (
      await post(`/timetables/${t.id}/entries`, {
        ...tuesdayEntry({ classroomId: ids.room1, startTime: '11:00', endTime: '12:00' }),
        sectionIds: [ids.sectionX],
        lecturerId: ids.lecturer2,
      }).expect(201)
    ).body;
    // The same lecturer in another room at an overlapping time: lecturer clash.
    const b = (
      await post(
        `/timetables/${t.id}/entries`,
        tuesdayEntry({ sectionIds: [ids.sectionB], startTime: '10:30', endTime: '11:30' }),
      ).expect(201)
    ).body;

    const check = (await get(`/timetables/${t.id}/conflicts`).expect(200)).body;
    expect(check.canPublish).toBe(false);
    expect(check.blocking.map((c: { kind: string }) => c.kind).sort()).toEqual([
      'LECTURER_CLASH',
      'ROOM_CLASH',
    ]);
    expect(check.blocking[0].message).toMatch(/from 2030-08-20, 18 dates/);
    const warnings = check.warnings.map((w: { kind: string }) => w.kind).sort();
    expect(warnings).toEqual(['ROOM_TOO_SMALL', 'STUDENT_CLASH']);
    expect(check.warnings.find((w: { kind: string }) => w.kind === 'STUDENT_CLASH').studentNumbers).toEqual([
      '99000002',
    ]);

    const refused = await post(`/timetables/${t.id}/publish`).expect(409);
    expect(refused.body.code).toBe('HAS_CONFLICTS');
    expect(refused.body.errors).toHaveLength(2);

    // Fix: move the other course to another room and day, and cancel the clashing entry.
    await http
      .patch(`/api/v1/timetable-entries/${x.id}`)
      .set(admin)
      .set('If-Match', '0')
      .send({
        ...tuesdayEntry({ classroomId: ids.room2, dayOfWeek: 3 }),
        sectionIds: [ids.sectionX],
        lecturerId: ids.lecturer2,
      })
      .expect(200);
    await post(`/timetable-entries/${b.id}/cancel`, { reason: 'Moved to next semester (test)' }).expect(200);
    const fixed = (await get(`/timetables/${t.id}/conflicts`).expect(200)).body;
    expect(fixed.blocking).toEqual([]);

    const published = (
      await post(`/timetables/${t.id}/publish`, { reason: 'First version (test)' }).expect(200)
    ).body;
    expect(published).toMatchObject({ status: 'PUBLISHED' });
    expect(published.publishedAt).toBeTruthy();
    // Published timetables are changed through the class lifecycle (step 4), not here.
    expect(
      (await post(`/timetables/${t.id}/entries`, tuesdayEntry({ dayOfWeek: 5 })).expect(409)).body.code,
    ).toBe('NOT_DRAFT');
    const history = (await get(`/timetables/${t.id}/history`).expect(200)).body.map(
      (h: { changeType: string }) => h.changeType,
    );
    expect(history).toEqual([
      'PUBLISHED',
      'ENTRY_CANCELLED',
      'ENTRY_UPDATED',
      'ENTRY_ADDED',
      'ENTRY_ADDED',
      'ENTRY_ADDED',
      'CREATED',
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'timetables.published' } })).toBe(1);
    expect(a.id).toBeTruthy();
  });

  it('starts the next draft as a copy, and publishing it supersedes the old version', async () => {
    const first = await draft();
    await post(`/timetables/${first.id}/entries`, tuesdayEntry()).expect(201);
    await post(`/timetables/${first.id}/publish`).expect(200);
    const second = await draft();
    expect(second.version).toBe(2);
    expect(second.entries).toHaveLength(1);
    await post(`/timetables/${second.id}/publish`).expect(200);
    const all = (await get(`/timetables?semesterId=${ids.semester}`).expect(200)).body;
    expect(all.map((t: { version: number; status: string }) => [t.version, t.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'SUPERSEDED'],
    ]);
  });

  it('refuses to publish an empty timetable, and requires university-wide scope', async () => {
    const t = await draft();
    expect((await post(`/timetables/${t.id}/publish`).expect(409)).body.code).toBe('EMPTY_TIMETABLE');
    const scoped = (
      await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.faculty },
      })
    ).auth;
    await post(`/timetables/${t.id}/publish`, {}, scoped).expect(403);
  });
});
