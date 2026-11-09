import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { readRows } from '../src/modules/imports/spreadsheet.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data only: 99xxxxxx Student IDs, TEST-* labels, example.test emails (CLAUDE.md rule 2).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let registrar: Record<string, string>;
let ids: Record<'faculty' | 'otherFaculty' | 'department' | 'offering' | 'sectionA' | 'sectionB', string>;
let placement: Record<'programmeId' | 'levelId' | 'academicYearId' | 'semesterId', string>;

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
  registrar = (await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR'])).auth;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const otherFaculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty' } });
  const department = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
  });
  const programme = await prisma.programme.create({
    data: { departmentId: department.id, code: 'TP', name: 'Test Programme' },
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
    data: { code: 'TST101', title: 'Test Course', departmentId: department.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const sectionA = await prisma.courseSection.create({
    data: { offeringId: offering.id, code: 'A', capacity: 2 },
  });
  const sectionB = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'B' } });
  ids = {
    faculty: faculty.id,
    otherFaculty: otherFaculty.id,
    department: department.id,
    offering: offering.id,
    sectionA: sectionA.id,
    sectionB: sectionB.id,
  };
  placement = {
    programmeId: programme.id,
    levelId: level.id,
    academicYearId: year.id,
    semesterId: semester.id,
  };
});

const post = (path: string, body: object = {}, auth = registrar) =>
  http.post(`/api/v1${path}`).set(auth).send(body);
const get = (path: string, auth = registrar) => http.get(`/api/v1${path}`).set(auth);

async function student(n: number, email = `student${n}@example.test`) {
  const res = await post('/students', {
    studentNumber: String(99000000 + n),
    fullName: `Test Student ${n}`,
    email,
    phone: `02455501${String(n).padStart(2, '0')}`,
    ...placement,
  }).expect(201);
  return res.body.student.id as string;
}

/** A lecturer account, optionally teaching a section. */
async function lecturer(email: string, sectionId?: string) {
  const signedIn = await signInAs(app, prisma, email, ['LECTURER']);
  const profile = await prisma.lecturerProfile.create({
    data: {
      userId: signedIn.user.id,
      staffNumber: `TL${email.length}${Date.now() % 1000}`,
      departmentId: ids.department,
    },
  });
  if (sectionId) {
    await prisma.lecturerAssignment.create({
      data: { lecturerId: profile.id, sectionId, assignedById: signedIn.user.id },
    });
  }
  return signedIn.auth;
}

describe('enrolling one student', () => {
  it('enrols, refuses a second section of the same offering, and respects capacity', async () => {
    const [s1, s2, s3] = [await student(1), await student(2), await student(3)];
    const e1 = (await post('/enrollments', { studentId: s1, sectionId: ids.sectionA }).expect(201)).body;
    expect(e1).toMatchObject({
      status: 'ENROLLED',
      section: { code: 'A' },
      course: { code: 'TST101' },
      student: { studentNumber: '99000001' },
    });
    expect(
      (await post('/enrollments', { studentId: s1, sectionId: ids.sectionB }).expect(409)).body.code,
    ).toBe('ALREADY_ENROLLED');
    await post('/enrollments', { studentId: s2, sectionId: ids.sectionA }).expect(201);
    expect(
      (await post('/enrollments', { studentId: s3, sectionId: ids.sectionA }).expect(409)).body.code,
    ).toBe('SECTION_FULL');
    await post('/enrollments', { studentId: s3, sectionId: ids.sectionB }).expect(201);
    expect(await prisma.auditLog.count({ where: { action: 'enrollments.created' } })).toBe(3);
  });

  it('never overfills a section when two enrolments arrive at the same moment', async () => {
    await prisma.courseSection.update({ where: { id: ids.sectionA }, data: { capacity: 1 } });
    const [s1, s2] = [await student(1), await student(2)];
    const results = await Promise.all([
      post('/enrollments', { studentId: s1, sectionId: ids.sectionA }),
      post('/enrollments', { studentId: s2, sectionId: ids.sectionA }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await prisma.courseEnrollment.count({ where: { sectionId: ids.sectionA, status: 'ENROLLED' } }),
    ).toBe(1);
  });

  it('refuses inactive students, closed offerings and unknown records', async () => {
    const s1 = await student(1);
    await prisma.studentProfile.update({ where: { id: s1 }, data: { status: 'DEFERRED' } });
    expect(
      (await post('/enrollments', { studentId: s1, sectionId: ids.sectionA }).expect(409)).body.code,
    ).toBe('STUDENT_NOT_ACTIVE');
    const s2 = await student(2);
    await prisma.courseOffering.update({ where: { id: ids.offering }, data: { status: 'CLOSED' } });
    expect(
      (await post('/enrollments', { studentId: s2, sectionId: ids.sectionA }).expect(409)).body.code,
    ).toBe('OFFERING_CLOSED');
    await post('/enrollments', {
      studentId: '01960000-0000-7000-8000-0000000000aa',
      sectionId: ids.sectionA,
    }).expect(404);
  });

  it('drops with a reason, keeps the history, and allows enrolling again', async () => {
    const s1 = await student(1);
    const e1 = (await post('/enrollments', { studentId: s1, sectionId: ids.sectionA }).expect(201)).body;
    await post(`/enrollments/${e1.id}/end`, {}).expect(400);
    const ended = (
      await post(`/enrollments/${e1.id}/end`, { reason: 'Changed programme (test)' }).expect(200)
    ).body;
    expect(ended).toMatchObject({ status: 'DROPPED', endReason: 'Changed programme (test)' });
    expect((await post(`/enrollments/${e1.id}/end`, { reason: 'Again (test)' }).expect(409)).body.code).toBe(
      'NOT_ENROLLED',
    );
    await post('/enrollments', { studentId: s1, sectionId: ids.sectionB }).expect(201);
    const history = (await get(`/enrollments?studentId=${s1}`).expect(200)).body.data;
    expect(history.map((e: { status: string }) => e.status).sort()).toEqual(['DROPPED', 'ENROLLED']);
  });

  it('shows the roster to course-rep administrators only within their scope', async () => {
    const s1 = await student(1);
    await post('/enrollments', { studentId: s1, sectionId: ids.sectionA }).expect(201);
    const inScope = (
      await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.faculty },
      })
    ).auth;
    const outOfScope = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;
    expect(
      (await get(`/course-sections/${ids.sectionA}/students`, inScope).expect(200)).body.enrolledCount,
    ).toBe(1);
    await get(`/course-sections/${ids.sectionA}/students`, outOfScope).expect(403);
  });

  it('shows a section roster to its lecturers and enrolment staff only, and students their own enrolments', async () => {
    const s1 = await student(1);
    await post('/enrollments', { studentId: s1, sectionId: ids.sectionA }).expect(201);
    const teaching = await lecturer('teaches.a@example.test', ids.sectionA);
    const other = await lecturer('teaches.b@example.test', ids.sectionB);
    const roster = (await get(`/course-sections/${ids.sectionA}/students`, teaching).expect(200)).body;
    expect(roster).toMatchObject({
      enrolledCount: 1,
      students: [{ studentNumber: '99000001', programme: { code: 'TP' } }],
    });
    await get(`/course-sections/${ids.sectionA}/students`, registrar).expect(200);
    await get(`/course-sections/${ids.sectionA}/students`, other).expect(403);

    const own = await signInAs(app, prisma, 'own.student@example.test', ['STUDENT']);
    const ownId = await student(5, 'own.student@example.test');
    await post('/enrollments', { studentId: ownId, sectionId: ids.sectionB }).expect(201);
    await get(`/course-sections/${ids.sectionA}/students`, own.auth).expect(403);
    const mine = (await get('/me/enrollments', own.auth).expect(200)).body.enrollments;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ section: { code: 'B' }, course: { code: 'TST101' } });
    await get('/enrollments', own.auth).expect(403);
  });
});

describe('bulk enrolment through the import pipeline', () => {
  const HEADER = 'student_number,course_code,academic_year,semester_number,section_code';

  it('checks, previews and enrols all valid rows on confirmation', async () => {
    const [s1] = [await student(1), await student(2), await student(3), await student(4), await student(6)];
    await post('/enrollments', { studentId: s1, sectionId: ids.sectionB }).expect(201); // 99000001 already enrolled
    const csv = [
      HEADER,
      '99000002,tst101,TEST-2030,1,a', // valid (codes are case-insensitive)
      '99000003,TST101,TEST-2030,1,A', // valid, fills section A (capacity 2)
      '99000004,TST101,TEST-2030,1,A', // over capacity
      '99000001,TST101,TEST-2030,1,A', // already enrolled in this offering
      '99000009,TST101,TEST-2030,1,B', // unknown student
      '99000006,TST101,TEST-2030,1,Z', // unknown section
      '99000006,TST101,TEST-2030,1,B', // valid
    ].join('\n');
    const up = await http
      .post('/api/v1/imports/enrollments')
      .set(registrar)
      .attach('file', Buffer.from(csv), 'enrol.csv')
      .expect(201);
    expect(up.body).toMatchObject({
      type: 'ENROLLMENTS',
      totalRows: 7,
      validRows: 3,
      invalidRows: 3,
      duplicateRows: 1,
    });
    expect(await prisma.courseEnrollment.count()).toBe(1);

    const rows = (await get(`/imports/enrollments/${up.body.id}/rows`).expect(200)).body.data;
    expect(
      Object.fromEntries(
        rows.map((r: { rowNumber: number; status: string; errors: { code: string }[] | null }) => [
          r.rowNumber,
          r.errors?.[0]?.code ?? r.status,
        ]),
      ),
    ).toEqual({
      2: 'VALID',
      3: 'VALID',
      4: 'SECTION_FULL',
      5: 'ALREADY_ENROLLED',
      6: 'UNKNOWN_STUDENT',
      7: 'UNKNOWN_SECTION',
      8: 'VALID',
    });

    // A student-import address cannot reach an enrolment batch.
    await get(`/imports/students/${up.body.id}`).expect(404);
    await post(`/imports/enrollments/${up.body.id}/activation-emails`).expect(404);

    const done = (await post(`/imports/enrollments/${up.body.id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', importedRows: 3 });
    expect(await prisma.courseEnrollment.count({ where: { importBatchId: up.body.id } })).toBe(3);
    const report = await get(`/imports/enrollments/${up.body.id}/error-report?format=csv`).expect(200);
    expect((await readRows(Buffer.from(report.text), 'csv')).rows).toHaveLength(4);
  });

  it('holds back a student listed twice for the same offering', async () => {
    await student(1);
    const csv = [HEADER, '99000001,TST101,TEST-2030,1,A', '99000001,TST101,TEST-2030,1,B'].join('\n');
    const up = await http
      .post('/api/v1/imports/enrollments')
      .set(registrar)
      .attach('file', Buffer.from(csv), 'twice.csv')
      .expect(201);
    expect(up.body).toMatchObject({ validRows: 0, duplicateRows: 2 });
  });

  it('needs the enrolment permission, not the student-import one', async () => {
    const { auth } = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/imports/enrollments/template').set(auth).expect(403);
    const template = await get('/imports/enrollments/template?format=csv').expect(200);
    expect(template.text.trim()).toBe(HEADER);
  });
});

describe('course reps (D-12)', () => {
  async function enrolled(n: number, sectionId = ids.sectionA) {
    const id = await student(n);
    await post('/enrollments', { studentId: id, sectionId }).expect(201);
    return id;
  }

  it('lets a scoped administrator appoint an enrolled student, and only within scope', async () => {
    const s1 = await enrolled(1);
    const notEnrolled = await student(2);
    const admin = (
      await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.faculty },
      })
    ).auth;
    const outsider = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;

    const rep = (
      await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: s1 }, admin).expect(201)
    ).body;
    expect(rep).toMatchObject({
      status: 'ACTIVE',
      student: { studentNumber: '99000001' },
      section: { code: 'A' },
    });
    expect(rep.startsAt).toBeTruthy();
    expect(
      (await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: s1 }, admin).expect(409)).body
        .code,
    ).toBe('ALREADY_REP');
    expect(
      (
        await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: notEnrolled }, admin).expect(
          409,
        )
      ).body.code,
    ).toBe('NOT_ENROLLED');
    await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: s1 }, outsider).expect(403);
    await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: s1 }, registrar).expect(403);

    await post(`/course-reps/${rep.id}/end`, {}, admin).expect(400);
    const ended = (
      await post(`/course-reps/${rep.id}/end`, { reason: 'Term handover (test)' }, admin).expect(200)
    ).body;
    expect(ended).toMatchObject({ status: 'ENDED', endReason: 'Term handover (test)' });
    expect(
      (await post(`/course-reps/${rep.id}/end`, { reason: 'Again (test)' }, admin).expect(409)).body.code,
    ).toBe('WRONG_STATUS');
  });

  it('lets a lecturer nominate in their own section, for an administrator to approve or reject', async () => {
    const [s1, s2] = [await enrolled(1), await enrolled(2)];
    const teaching = await lecturer('teaches.a@example.test', ids.sectionA);
    const other = await lecturer('teaches.b@example.test', ids.sectionB);
    const admin = (await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN'])).auth;

    expect(
      (
        await post(
          `/course-sections/${ids.sectionA}/course-rep-nominations`,
          { studentId: s1 },
          other,
        ).expect(403)
      ).body.code,
    ).toBe('NOT_YOUR_SECTION');
    const n1 = (
      await post(
        `/course-sections/${ids.sectionA}/course-rep-nominations`,
        { studentId: s1, note: 'Reliable and organised (test)' },
        teaching,
      ).expect(201)
    ).body;
    expect(n1).toMatchObject({ status: 'NOMINATED', nominationNote: 'Reliable and organised (test)' });
    const n2 = (
      await post(
        `/course-sections/${ids.sectionA}/course-rep-nominations`,
        { studentId: s2 },
        teaching,
      ).expect(201)
    ).body;
    await post(`/course-reps/${n1.id}/approve`, {}, teaching).expect(403);

    expect((await post(`/course-reps/${n1.id}/approve`, {}, admin).expect(200)).body.status).toBe('ACTIVE');
    expect(
      (await post(`/course-reps/${n2.id}/reject`, { reason: 'One rep is enough (test)' }, admin).expect(200))
        .body.status,
    ).toBe('REJECTED');
    expect((await post(`/course-reps/${n2.id}/approve`, {}, admin).expect(409)).body.code).toBe(
      'WRONG_STATUS',
    );

    const listed = (await get(`/course-sections/${ids.sectionA}/course-reps`, teaching).expect(200)).body
      .data;
    expect(listed.map((r: { status: string }) => r.status).sort()).toEqual(['ACTIVE', 'REJECTED']);
    await get(`/course-sections/${ids.sectionA}/course-reps`, other).expect(403);
  });

  it('ends a rep role when the enrolment ends, and shows students their own rep roles', async () => {
    await signInAs(app, prisma, 'own.student@example.test', ['STUDENT']);
    const own = await prisma.user.findUniqueOrThrow({ where: { email: 'own.student@example.test' } });
    const ownId = await student(5, 'own.student@example.test');
    const enrolment = (await post('/enrollments', { studentId: ownId, sectionId: ids.sectionA }).expect(201))
      .body;
    const admin = (await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN'])).auth;
    const rep = (
      await post(`/course-sections/${ids.sectionA}/course-reps`, { studentId: ownId }, admin).expect(201)
    ).body;

    const session = await signInAs(app, prisma, 'second.session@example.test', ['STUDENT']);
    expect((await get('/me/course-reps', session.auth).expect(200)).body.courseReps).toEqual([]);
    const { SessionService } = await import('../src/modules/auth/session.service.js');
    const { TokenService } = await import('../src/modules/auth/token.service.js');
    const created = await app.get(SessionService).create({
      userId: own.id,
      client: 'MOBILE',
      role: 'STUDENT',
      mfaVerified: false,
      context: { requestId: undefined, ip: undefined, userAgent: undefined },
    });
    const { token } = await app
      .get(TokenService)
      .signAccess({ userId: own.id, sessionId: created.session.id, role: 'STUDENT' });
    const ownAuth = { Authorization: `Bearer ${token}` };
    expect((await get('/me/course-reps', ownAuth).expect(200)).body.courseReps).toMatchObject([
      { id: rep.id, section: { code: 'A' } },
    ]);

    await post(`/enrollments/${enrolment.id}/end`, { reason: 'Left the course (test)' }).expect(200);
    const after = await prisma.courseRepAssignment.findUniqueOrThrow({ where: { id: rep.id } });
    expect(after).toMatchObject({ status: 'ENDED', endReason: 'Enrolment dropped: Left the course (test)' });
    expect((await get('/me/course-reps', ownAuth).expect(200)).body.courseReps).toEqual([]);
  });
});
