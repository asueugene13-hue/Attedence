import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { createUser, resetDatabase, resetRedis, signInAs, TEST_PASSWORD } from './fixtures.js';

// Obviously fake students: 99xxxxxx Student IDs and example.test emails (CLAUDE.md rule 2).
const sentMail: MailMessage[] = [];
const fakeMail = { send: async (m: MailMessage) => void sentMail.push(m), onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let registrar: Record<string, string>;
let ids: Record<
  'faculty' | 'department' | 'otherDepartment' | 'programme' | 'level' | 'year' | 'semester',
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
  sentMail.length = 0;
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  registrar = (await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR'])).auth;
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
  ids = {
    faculty: faculty.id,
    department: department.id,
    otherDepartment: otherDepartment.id,
    programme: programme.id,
    level: level.id,
    year: year.id,
    semester: semester.id,
  };
});

const post = (path: string, body: object, auth = registrar, headers: Record<string, string> = {}) =>
  http.post(`/api/v1${path}`).set(auth).set(headers).send(body);
const patch = (path: string, body: object, headers: Record<string, string> = {}, auth = registrar) =>
  http.patch(`/api/v1${path}`).set(auth).set(headers).send(body);
const get = (path: string, auth = registrar) => http.get(`/api/v1${path}`).set(auth);

function registration(overrides: Record<string, unknown> = {}) {
  return {
    studentNumber: '99000001',
    fullName: 'Test Student One',
    email: 'Test.Student1@example.test',
    phone: '024 555 0101',
    programmeId: ids.programme,
    levelId: ids.level,
    academicYearId: ids.year,
    semesterId: ids.semester,
    ...overrides,
  };
}

describe('registering students', () => {
  it('creates the account, Student role and profile, derives faculty and department, and sends activation', async () => {
    const res = await post(
      '/students',
      registration({ facultyId: ids.faculty, departmentId: ids.department }),
    ).expect(201);
    expect(res.body).toMatchObject({ newAccount: true, activationEmailSent: true });
    expect(res.body.student).toMatchObject({
      studentNumber: '99000001',
      email: 'test.student1@example.test',
      phone: '0245550101',
      status: 'ACTIVE',
      accountStatus: 'PENDING_ACTIVATION',
      programme: { code: 'TP' },
      department: { code: 'TD' },
      faculty: { code: 'TF' },
      level: { code: 'L1' },
      academicYear: { label: 'TEST-2030' },
      verifiedAt: null,
      version: 0,
    });
    expect(sentMail.at(-1)?.to).toBe('test.student1@example.test');
    const roles = await prisma.userRole.findMany({
      where: { user: { email: 'test.student1@example.test' } },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.key)).toEqual(['STUDENT']);
    expect(await prisma.auditLog.count({ where: { action: 'students.registered' } })).toBe(1);
  });

  it('accepts only an 8-digit Student ID and refuses duplicates', async () => {
    for (const bad of ['9900001', '990000011', '99-00001', 'ABCDEFGH']) {
      const res = await post('/students', registration({ studentNumber: bad })).expect(400);
      expect(res.body.errors[0].field).toBe('studentNumber');
    }
    await post('/students', registration()).expect(201);
    const dup = await post('/students', registration({ email: 'other@example.test' })).expect(409);
    expect(dup.body.code).toBe('STUDENT_NUMBER_IN_USE');
    const sameEmail = await post('/students', registration({ studentNumber: '99000002' })).expect(409);
    expect(sameEmail.body.code).toBe('ALREADY_STUDENT');
  });

  it('refuses placements that contradict each other', async () => {
    const wrongDept = await post('/students', registration({ departmentId: ids.otherDepartment })).expect(
      400,
    );
    expect(wrongDept.body.code).toBe('PLACEMENT_MISMATCH');
    const otherYear = await prisma.academicYear.create({
      data: { label: 'TEST-2031', startDate: new Date('2031-08-01'), endDate: new Date('2032-07-31') },
    });
    const wrongYear = await post('/students', registration({ academicYearId: otherYear.id })).expect(400);
    expect(wrongYear.body.code).toBe('PLACEMENT_MISMATCH');
    await prisma.programme.update({ where: { id: ids.programme }, data: { isActive: false } });
    expect((await post('/students', registration()).expect(400)).body.code).toBe('INVALID_PROGRAMME');
  });

  it('requires a valid Ghana phone number', async () => {
    const res = await post('/students', registration({ phone: '12345' })).expect(400);
    expect(res.body.errors[0].field).toBe('phone');
  });

  it('adds a student profile to an existing staff account instead of a second account', async () => {
    const staff = await createUser(prisma, { email: 'staff.studies@example.test', roles: ['LECTURER'] });
    const res = await post('/students', registration({ email: 'staff.studies@example.test' })).expect(201);
    expect(res.body).toMatchObject({ newAccount: false, activationEmailSent: null });
    const roles = (await prisma.userRole.findMany({ where: { userId: staff.id }, include: { role: true } }))
      .map((r) => r.role.key)
      .sort();
    expect(roles).toEqual(['LECTURER', 'STUDENT']);
  });
});

describe('student records', () => {
  it('lists with filters and search', async () => {
    await post('/students', registration()).expect(201);
    await post(
      '/students',
      registration({ studentNumber: '99000002', email: 'two@example.test', fullName: 'Second Student' }),
    ).expect(201);
    expect((await get('/students?q=9900000').expect(200)).body.data).toHaveLength(2);
    expect((await get('/students?q=second').expect(200)).body.data).toHaveLength(1);
    expect(
      (await get(`/students?departmentId=${ids.department}&facultyId=${ids.faculty}`).expect(200)).body.data,
    ).toHaveLength(2);
    expect(
      (await get(`/students?departmentId=${ids.otherDepartment}&facultyId=${ids.faculty}`).expect(200)).body
        .data,
    ).toHaveLength(0);
  });

  it('edits with a version check so two editors cannot overwrite each other', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    await patch(`/students/${created.id}`, { fullName: 'Renamed Student' }).expect(400);
    const updated = (
      await patch(`/students/${created.id}`, { fullName: 'Renamed Student' }, { 'If-Match': '0' }).expect(200)
    ).body;
    expect(updated).toMatchObject({ fullName: 'Renamed Student', version: 1 });
    const stale = await patch(`/students/${created.id}`, { phone: '0245550199' }, { 'If-Match': '0' }).expect(
      409,
    );
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('changes academic status with a reason and verifies the record', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    await post(`/students/${created.id}/status`, { status: 'DEFERRED' }, registrar, {
      'If-Match': '0',
    }).expect(400);
    const deferred = (
      await post(
        `/students/${created.id}/status`,
        { status: 'DEFERRED', reason: 'Requested deferral (test)' },
        registrar,
        { 'If-Match': '0' },
      ).expect(200)
    ).body;
    expect(deferred).toMatchObject({ status: 'DEFERRED', version: 1 });
    const verified = (
      await post(`/students/${created.id}/verify`, {}, registrar, { 'If-Match': '1' }).expect(200)
    ).body;
    expect(verified.verifiedAt).toBeTruthy();
    expect(
      (await post(`/students/${created.id}/verify`, {}, registrar, { 'If-Match': '2' }).expect(409)).body
        .code,
    ).toBe('ALREADY_VERIFIED');
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'students.status_changed' } });
    expect(entry.reason).toBe('Requested deferral (test)');
  });

  it('is limited to the Registrar and Super Admin', async () => {
    await post('/students', registration()).expect(201);
    for (const role of ['LECTURER', 'UNIVERSITY_ADMIN', 'STUDENT'] as const) {
      const { auth } = await signInAs(app, prisma, `${role.toLowerCase()}@example.test`, [role]);
      await get('/students', auth).expect(403);
      await post(
        '/students',
        registration({ studentNumber: '99000009', email: 'x9@example.test' }),
        auth,
      ).expect(403);
    }
  });
});

describe('students signing in', () => {
  it('signs in with the Student ID as well as the email, and sees their own record', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    await prisma.user.update({
      where: { email: 'test.student1@example.test' },
      data: {
        status: 'ACTIVE',
        passwordHash: (await prisma.user.findFirstOrThrow({ where: { email: 'registrar@example.test' } }))
          .passwordHash,
      },
    });
    const byId = await http
      .post('/api/v1/auth/login')
      .send({ identifier: '99000001', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(200);
    expect(byId.body.activeRole).toBe('STUDENT');
    await http
      .post('/api/v1/auth/login')
      .send({ identifier: 'test.student1@example.test', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(200);
    const unknown = await http
      .post('/api/v1/auth/login')
      .send({ identifier: '99999999', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(401);
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    await http
      .post('/api/v1/auth/login')
      .send({ identifier: '99000001', email: 'a@example.test', password: 'x', client: 'MOBILE' })
      .expect(400);

    const mine = (
      await http.get('/api/v1/me/student').set('Authorization', `Bearer ${byId.body.accessToken}`).expect(200)
    ).body;
    expect(mine.student).toMatchObject({
      id: created.id,
      studentNumber: '99000001',
      programme: { code: 'TP' },
    });
  });
});

describe('faculty- and department-limited administrators', () => {
  it('grants a scoped University Administrator role against a real faculty, and refuses invalid scopes', async () => {
    const superAdmin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
    const target = await createUser(prisma, { email: 'fac.admin@example.test' });
    const grant = (body: object) =>
      http
        .post(`/api/v1/users/${target.id}/roles`)
        .set(superAdmin)
        .send({ reason: 'Faculty officer (test)', ...body });

    const ok = await grant({ role: 'UNIVERSITY_ADMIN', scopeType: 'FACULTY', scopeId: ids.faculty }).expect(
      200,
    );
    expect(ok.body.roles[0]).toMatchObject({
      role: 'UNIVERSITY_ADMIN',
      scopeType: 'FACULTY',
      scopeId: ids.faculty,
    });
    expect(
      (
        await grant({
          role: 'UNIVERSITY_ADMIN',
          scopeType: 'DEPARTMENT',
          scopeId: '01960000-0000-7000-8000-0000000000dd',
        }).expect(400)
      ).body.code,
    ).toBe('INVALID_SCOPE');
    await grant({ role: 'REGISTRAR', scopeType: 'FACULTY', scopeId: ids.faculty }).expect(400);
    await grant({ role: 'UNIVERSITY_ADMIN', scopeType: 'FACULTY' }).expect(400);
  });
});

describe('profile photos', () => {
  // Only the first bytes matter for the type check; the rest stands in for image data.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake png body'),
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
  const upload = (id: string, bytes: Buffer, name: string, version?: number) => {
    const req = http.post(`/api/v1/students/${id}/photo`).set(registrar);
    if (version !== undefined) req.set('If-Match', String(version));
    return req.attach('photo', bytes, name);
  };

  it('stores a JPEG or PNG privately, hands out short-lived links, and replaces or removes it', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    expect(created.hasPhoto).toBe(false);
    await upload(created.id, png, 'me.png').expect(400); // no If-Match
    const withPhoto = (await upload(created.id, png, 'me.png', 0).expect(200)).body;
    expect(withPhoto).toMatchObject({ hasPhoto: true, version: 1 });

    const link = (await get(`/students/${created.id}/photo`).expect(200)).body;
    expect(link).toMatchObject({ mimeType: 'image/png', sizeBytes: png.length });
    const fetched = await fetch(link.url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(png)).toBe(true);

    const first = await prisma.studentProfile.findUniqueOrThrow({ where: { id: created.id } });
    await upload(created.id, jpeg, 'me.jpg', 1).expect(200);
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: first.photoFileId! } })).status).toBe(
      'REMOVED',
    );
    expect((await get(`/students/${created.id}/photo`).expect(200)).body.mimeType).toBe('image/jpeg');

    await http
      .delete(`/api/v1/students/${created.id}/photo`)
      .set(registrar)
      .set('If-Match', '2')
      .send({})
      .expect(400);
    const removed = (
      await http
        .delete(`/api/v1/students/${created.id}/photo`)
        .set(registrar)
        .set('If-Match', '2')
        .send({ reason: 'Wrong person (test)' })
        .expect(200)
    ).body;
    expect(removed).toMatchObject({ hasPhoto: false, version: 3 });
    expect((await get(`/students/${created.id}/photo`).expect(404)).body.code).toBe('NO_PHOTO');
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'students.photo_' } } })).toBe(3);
  });

  it('checks the real file type, not the name, and the size limit', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    const res = await upload(created.id, Buffer.from('just text, not an image'), 'photo.png', 0).expect(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    await upload(created.id, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), 'big.png', 0).expect(413);
    await http.post(`/api/v1/students/${created.id}/photo`).set(registrar).set('If-Match', '0').expect(400);
    expect(await prisma.fileObject.count()).toBe(0);
  });

  it('lets a student fetch their own photo link', async () => {
    const created = (await post('/students', registration()).expect(201)).body.student;
    await upload(created.id, png, 'me.png', 0).expect(200);
    await prisma.user.update({
      where: { email: 'test.student1@example.test' },
      data: {
        status: 'ACTIVE',
        passwordHash: (await prisma.user.findFirstOrThrow({ where: { email: 'registrar@example.test' } }))
          .passwordHash,
      },
    });
    const login = await http
      .post('/api/v1/auth/login')
      .send({ identifier: '99000001', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(200);
    const mine = await http
      .get('/api/v1/me/student/photo')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(mine.body.url).toContain('profile-photo/');
  });
});
