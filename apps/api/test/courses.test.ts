import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake academic data (CLAUDE.md rule 2).
const sentMail: MailMessage[] = [];
const fakeMail = { send: async (m: MailMessage) => void sentMail.push(m), onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let ids: {
  faculty: string;
  department: string;
  otherDepartment: string;
  semester: string;
  programme: string;
};

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
  // Cleared after the reset, which waits for the previous test's emails to finish.
  sentMail.length = 0;
  await resetRedis(app.get(RedisService));
  admin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const department = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
  });
  const otherDepartment = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'OD', name: 'Other Department' },
  });
  const programme = await prisma.programme.create({
    data: { departmentId: department.id, code: 'TP', name: 'Test Programme' },
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
  ids = {
    faculty: faculty.id,
    department: department.id,
    otherDepartment: otherDepartment.id,
    semester: semester.id,
    programme: programme.id,
  };
});

const post = (path: string, body: object, auth = admin) => http.post(`/api/v1${path}`).set(auth).send(body);
const patch = (path: string, body: object, auth = admin) => http.patch(`/api/v1${path}`).set(auth).send(body);
const get = (path: string, auth = admin) => http.get(`/api/v1${path}`).set(auth);

async function courseOfferingSection() {
  const course = (
    await post('/courses', {
      departmentId: ids.department,
      code: 'tst101',
      title: 'Test Course One',
      creditHours: 3,
    }).expect(201)
  ).body;
  const offering = (
    await post('/course-offerings', { courseId: course.id, semesterId: ids.semester }).expect(201)
  ).body;
  const section = (
    await post('/course-sections', { offeringId: offering.id, code: 'a', programmeId: ids.programme }).expect(
      201,
    )
  ).body;
  return { course, offering, section };
}

async function lecturer(email = 'lecturer.one@example.test', staffNumber = 'test/0001') {
  return (
    await post('/lecturers', {
      email,
      fullName: 'Lecturer One (test)',
      staffNumber,
      departmentId: ids.department,
      title: 'Dr',
    }).expect(201)
  ).body;
}

describe('courses, offerings and sections', () => {
  it('creates a course, offers it in a semester and adds a section', async () => {
    const { course, offering, section } = await courseOfferingSection();
    expect(course.code).toBe('TST101');
    expect(offering.status).toBe('DRAFT');
    expect(section.code).toBe('A');

    const offerings = (await get(`/course-offerings?semesterId=${ids.semester}`).expect(200)).body;
    expect(offerings[0]).toMatchObject({
      course: { code: 'TST101' },
      sections: [{ code: 'A', programme: { code: 'TP' }, assignments: [] }],
    });
    await post('/course-offerings', { courseId: course.id, semesterId: ids.semester }).expect(409);
    await post('/courses', { departmentId: ids.department, code: 'TST101', title: 'Duplicate' }).expect(409);
  });

  it('moves offerings DRAFT → OPEN → CLOSED only, and freezes closed offerings', async () => {
    const { course, offering, section } = await courseOfferingSection();
    await http.post(`/api/v1/course-offerings/${offering.id}/open`).set(admin).expect(200);
    expect((await patch(`/courses/${course.id}`, { isActive: false }).expect(409)).body.code).toBe(
      'HAS_OPEN_OFFERINGS',
    );
    await http.post(`/api/v1/course-offerings/${offering.id}/close`).set(admin).expect(200);
    expect(
      (await http.post(`/api/v1/course-offerings/${offering.id}/open`).set(admin).expect(409)).body.code,
    ).toBe('INVALID_TRANSITION');
    expect(
      (await post('/course-sections', { offeringId: offering.id, code: 'B' }).expect(409)).body.code,
    ).toBe('OFFERING_CLOSED');
    await patch(`/course-sections/${section.id}`, { capacity: 30 }).expect(409);
    await patch(`/courses/${course.id}`, { isActive: false }).expect(200);
  });

  it('refuses offerings in a closed semester and unknown section hints', async () => {
    const course = (
      await post('/courses', {
        departmentId: ids.department,
        code: 'TST102',
        title: 'Test Course Two',
      }).expect(201)
    ).body;
    await prisma.semester.update({ where: { id: ids.semester }, data: { status: 'CLOSED' } });
    expect(
      (await post('/course-offerings', { courseId: course.id, semesterId: ids.semester }).expect(409)).body
        .code,
    ).toBe('SEMESTER_CLOSED');
    await prisma.semester.update({ where: { id: ids.semester }, data: { status: 'PLANNED' } });
    const offering = (
      await post('/course-offerings', { courseId: course.id, semesterId: ids.semester }).expect(201)
    ).body;
    const bad = await post('/course-sections', {
      offeringId: offering.id,
      code: 'A',
      levelId: '01960000-0000-7000-8000-0000000000ee',
    }).expect(400);
    expect(bad.body.code).toBe('INVALID_LEVEL');
  });

  it('keeps a department-scoped administrator to their department', async () => {
    const { auth } = await signInAs(app, prisma, 'dept.admin@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: ids.department },
    });
    await post('/courses', { departmentId: ids.department, code: 'MINE1', title: 'Mine' }, auth).expect(201);
    const res = await post(
      '/courses',
      { departmentId: ids.otherDepartment, code: 'NOT1', title: 'Not Mine' },
      auth,
    ).expect(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
  });

  it('lets a registrar read but not change courses', async () => {
    await courseOfferingSection();
    const { auth } = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
    expect((await get('/courses', auth).expect(200)).body).toHaveLength(1);
    await post('/courses', { departmentId: ids.department, code: 'NOPE', title: 'Nope' }, auth).expect(403);
  });
});

describe('lecturers', () => {
  it('creates a new lecturer account with the Lecturer role and an activation email', async () => {
    const result = await lecturer();
    expect(result).toMatchObject({
      newAccount: true,
      activationEmailSent: true,
      lecturer: { staffNumber: 'TEST/0001', title: 'Dr' },
    });
    expect(sentMail.at(-1)?.to).toBe('lecturer.one@example.test');
    const grants = await prisma.userRole.findMany({
      where: { userId: result.lecturer.userId },
      include: { role: true },
    });
    expect(grants.map((g) => g.role.key)).toEqual(['LECTURER']);
    expect(
      (
        await post('/lecturers', {
          email: 'two@example.test',
          fullName: 'Two (test)',
          staffNumber: 'TEST/0001',
          departmentId: ids.department,
        }).expect(409)
      ).body.code,
    ).toBe('STAFF_NUMBER_IN_USE');
  });

  it('adds a lecturer profile and role to an existing account instead of creating a second one', async () => {
    const existing = await createUser(prisma, {
      email: 'admin.teaches@example.test',
      roles: ['UNIVERSITY_ADMIN'],
    });
    const result = (
      await post('/lecturers', {
        email: 'Admin.Teaches@example.test',
        fullName: 'Ignored Name',
        staffNumber: 'TEST/0002',
        departmentId: ids.department,
      }).expect(201)
    ).body;
    expect(result).toMatchObject({ newAccount: false, activationEmailSent: null });
    expect(result.lecturer.userId).toBe(existing.id);
    expect(sentMail).toHaveLength(0);
    const roles = (
      await prisma.userRole.findMany({ where: { userId: existing.id }, include: { role: true } })
    )
      .map((g) => g.role.key)
      .sort();
    expect(roles).toEqual(['LECTURER', 'UNIVERSITY_ADMIN']);
    expect(
      (
        await post('/lecturers', {
          email: 'admin.teaches@example.test',
          fullName: 'Second Try (test)',
          staffNumber: 'TEST/0003',
          departmentId: ids.department,
        }).expect(409)
      ).body.code,
    ).toBe('ALREADY_LECTURER');
  });

  it('lists and finds lecturers', async () => {
    await lecturer();
    const found = (await get('/lecturers?q=0001').expect(200)).body;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      user: { email: 'lecturer.one@example.test' },
      department: { code: 'TD' },
    });
  });
});

describe('lecturer assignments', () => {
  it('allows one primary per section, assistants beside them, and keeps history when ended', async () => {
    const { section } = await courseOfferingSection();
    const one = (await lecturer('one@example.test', 'TEST/0001')).lecturer;
    const two = (await lecturer('two@example.test', 'TEST/0002')).lecturer;

    const primary = (
      await post(`/course-sections/${section.id}/lecturers`, { lecturerId: one.id }).expect(201)
    ).body;
    expect(
      (await post(`/course-sections/${section.id}/lecturers`, { lecturerId: two.id }).expect(409)).body.code,
    ).toBe('PRIMARY_EXISTS');
    await post(`/course-sections/${section.id}/lecturers`, { lecturerId: two.id, isPrimary: false }).expect(
      201,
    );
    expect(
      (
        await post(`/course-sections/${section.id}/lecturers`, {
          lecturerId: two.id,
          isPrimary: false,
        }).expect(409)
      ).body.code,
    ).toBe('ALREADY_ASSIGNED');

    await http
      .post(`/api/v1/course-sections/${section.id}/lecturers/${primary.id}/end`)
      .set(admin)
      .send({})
      .expect(400);
    await http
      .post(`/api/v1/course-sections/${section.id}/lecturers/${primary.id}/end`)
      .set(admin)
      .send({ reason: 'Reassigned for the semester (test)' })
      .expect(204);
    await post(`/course-sections/${section.id}/lecturers`, { lecturerId: one.id }).expect(201);
    expect(await prisma.lecturerAssignment.count({ where: { sectionId: section.id } })).toBe(3);
    expect(await prisma.lecturerAssignment.count({ where: { sectionId: section.id, endedAt: null } })).toBe(
      2,
    );
  });

  it('will not assign a suspended lecturer', async () => {
    const { section } = await courseOfferingSection();
    const one = (await lecturer()).lecturer;
    await prisma.user.update({ where: { id: one.userId }, data: { status: 'SUSPENDED' } });
    expect(
      (await post(`/course-sections/${section.id}/lecturers`, { lecturerId: one.id }).expect(409)).body.code,
    ).toBe('LECTURER_UNAVAILABLE');
  });

  it('shows a lecturer their own teaching, and nothing to others', async () => {
    const { section } = await courseOfferingSection();
    const created = (await lecturer()).lecturer;
    await prisma.user.update({ where: { id: created.userId }, data: { status: 'ACTIVE' } });
    await post(`/course-sections/${section.id}/lecturers`, { lecturerId: created.id }).expect(201);

    const { SessionService } = await import('../src/modules/auth/session.service.js');
    const { TokenService } = await import('../src/modules/auth/token.service.js');
    const { session } = await app.get(SessionService).create({
      userId: created.userId,
      client: 'MOBILE',
      role: 'LECTURER',
      mfaVerified: false,
      context: { requestId: undefined, ip: undefined, userAgent: undefined },
    });
    const { token } = await app
      .get(TokenService)
      .signAccess({ userId: created.userId, sessionId: session.id, role: 'LECTURER' });
    const mine = (await get('/me/teaching', { Authorization: `Bearer ${token}` }).expect(200)).body;
    expect(mine.sections).toHaveLength(1);
    expect(mine.sections[0]).toMatchObject({ sectionCode: 'A', isPrimary: true, course: { code: 'TST101' } });

    const student = await signInAs(app, prisma, 'student@example.test', ['STUDENT']);
    expect((await get('/me/teaching', student.auth).expect(200)).body).toEqual({
      lecturer: null,
      sections: [],
    });
  });
});
