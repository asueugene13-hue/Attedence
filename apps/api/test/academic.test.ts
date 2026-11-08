import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake academic data (CLAUDE.md rule 2): nothing here describes Knutsford University.
const fakeMail = { send: async (_m: MailMessage) => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;

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
  admin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
});

const post = (path: string, body: object, auth = admin) => http.post(`/api/v1${path}`).set(auth).send(body);
const patch = (path: string, body: object, auth = admin) => http.patch(`/api/v1${path}`).set(auth).send(body);
const get = (path: string, auth = admin) => http.get(`/api/v1${path}`).set(auth);

async function faculty(code = 'TF1', name = 'Test Faculty One') {
  return (await post('/faculties', { code, name }).expect(201)).body as { id: string };
}
async function department(facultyId: string, code = 'TD1') {
  return (await post('/departments', { facultyId, code, name: `Test Department ${code}` }).expect(201))
    .body as {
    id: string;
  };
}

describe('faculties, departments and programmes', () => {
  it('creates the hierarchy, normalises codes and audits every change', async () => {
    const f = await faculty('tf1', 'Test Faculty One');
    const d = await department(f.id, 'td1');
    const p = (
      await post('/programmes', {
        departmentId: d.id,
        code: 'tp-1',
        name: 'Test Programme',
        durationYears: 4,
      }).expect(201)
    ).body;
    expect(p.code).toBe('TP-1');

    const faculties = (await get('/faculties').expect(200)).body;
    expect(faculties).toHaveLength(1);
    expect(faculties[0]).toMatchObject({ code: 'TF1', _count: { departments: 1 } });
    const programmes = (await get(`/programmes?facultyId=${f.id}`).expect(200)).body;
    expect(programmes.map((x: { code: string }) => x.code)).toEqual(['TP-1']);

    const actions = (await prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual([
      'academic.faculty.created',
      'academic.department.created',
      'academic.programme.created',
    ]);
  });

  it('refuses duplicate codes, whatever the letter case', async () => {
    await faculty('TF1');
    const res = await post('/faculties', { code: 'tf1', name: 'Another' }).expect(409);
    expect(res.body.code).toBe('CODE_IN_USE');
  });

  it('rejects malformed input and unknown fields', async () => {
    await post('/faculties', { code: 'has space', name: 'X faculty' }).expect(400);
    await post('/faculties', { code: 'OK', name: 'X' }).expect(400);
    await post('/faculties', { code: 'OK', name: 'Fine name', isDeleted: true }).expect(400);
  });

  it('will not deactivate a parent with active children, nor add under an inactive parent', async () => {
    const f = await faculty();
    const d = await department(f.id);
    const blocked = await patch(`/faculties/${f.id}`, { isActive: false }).expect(409);
    expect(blocked.body.code).toBe('HAS_ACTIVE_CHILDREN');

    await patch(`/departments/${d.id}`, { isActive: false }).expect(200);
    await patch(`/faculties/${f.id}`, { isActive: false }).expect(200);
    const under = await post('/departments', {
      facultyId: f.id,
      code: 'TD2',
      name: 'Late Department',
    }).expect(400);
    expect(under.body.code).toBe('PARENT_INACTIVE');
    const revive = await patch(`/departments/${d.id}`, { isActive: true }).expect(400);
    expect(revive.body.code).toBe('PARENT_INACTIVE');

    expect((await get('/faculties').expect(200)).body).toHaveLength(0);
    expect((await get('/faculties?includeInactive=true').expect(200)).body).toHaveLength(1);
  });

  it('lets a registrar read but not change the structure', async () => {
    await faculty();
    const { auth } = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
    expect((await get('/faculties', auth).expect(200)).body).toHaveLength(1);
    await post('/faculties', { code: 'TF9', name: 'Not Allowed' }, auth).expect(403);
  });

  it('keeps a faculty-scoped administrator inside their faculty', async () => {
    const mine = await faculty('MINE', 'My Faculty');
    const other = await faculty('OTHER', 'Other Faculty');
    // University Administrators may manage the structure only once the Super Admin switches it on.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: 'academic_structure.manage' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const { auth } = await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'FACULTY', id: mine.id },
    });

    await post('/departments', { facultyId: mine.id, code: 'MD1', name: 'Mine Department' }, auth).expect(
      201,
    );
    const outside = await post(
      '/departments',
      { facultyId: other.id, code: 'OD1', name: 'Other Dept' },
      auth,
    ).expect(403);
    expect(outside.body.code).toBe('OUT_OF_SCOPE');
    const institutionLevel = await post('/faculties', { code: 'NEW', name: 'New Faculty' }, auth).expect(403);
    expect(institutionLevel.body.code).toBe('INSTITUTION_SCOPE_REQUIRED');
  });
});

describe('academic levels', () => {
  it('orders levels and refuses a duplicate position', async () => {
    await post('/academic-levels', { code: 'L2', name: 'Level Two (test)', sortOrder: 2 }).expect(201);
    await post('/academic-levels', { code: 'L1', name: 'Level One (test)', sortOrder: 1 }).expect(201);
    expect((await get('/academic-levels').expect(200)).body.map((l: { code: string }) => l.code)).toEqual([
      'L1',
      'L2',
    ]);
    await post('/academic-levels', { code: 'L3', name: 'Level Clash', sortOrder: 1 }).expect(409);
  });
});

describe('academic years and semesters', () => {
  async function year(label = 'TEST-2030', startDate = '2030-08-01', endDate = '2031-07-31') {
    return (await post('/academic-years', { label, startDate, endDate }).expect(201)).body as { id: string };
  }

  it('returns plain dates and refuses overlapping years', async () => {
    const y = await year();
    const list = (await get('/academic-years').expect(200)).body;
    expect(list[0]).toMatchObject({
      id: y.id,
      startDate: '2030-08-01',
      endDate: '2031-07-31',
      isCurrent: false,
    });
    const overlap = await post('/academic-years', {
      label: 'TEST-OVERLAP',
      startDate: '2031-07-31',
      endDate: '2032-07-30',
    }).expect(409);
    expect(overlap.body.code).toBe('PERIOD_OVERLAP');
    await post('/academic-years', {
      label: 'TEST-BACKWARDS',
      startDate: '2033-01-01',
      endDate: '2032-01-01',
    }).expect(400);
  });

  it('keeps semesters inside their year and apart from each other', async () => {
    const y = await year();
    const s1 = {
      academicYearId: y.id,
      number: 1,
      name: 'First (test)',
      startDate: '2030-08-15',
      endDate: '2030-12-20',
    };
    await post('/semesters', s1).expect(201);
    const outside = await post('/semesters', {
      ...s1,
      number: 2,
      startDate: '2031-06-01',
      endDate: '2031-08-30',
    }).expect(400);
    expect(outside.body.code).toBe('INVALID_DATES');
    const overlap = await post('/semesters', {
      ...s1,
      number: 2,
      startDate: '2030-12-01',
      endDate: '2031-04-30',
    }).expect(409);
    expect(overlap.body.code).toBe('PERIOD_OVERLAP');
    const dupNumber = await post('/semesters', {
      ...s1,
      startDate: '2031-01-10',
      endDate: '2031-05-01',
    }).expect(409);
    expect(dupNumber.body.code).toBe('NUMBER_IN_USE');
    // A year cannot shrink so that a semester falls outside it.
    await patch(`/academic-years/${y.id}`, { startDate: '2030-09-01' }).expect(400);
  });

  it('runs one semester at a time and makes its year current', async () => {
    const y = await year();
    const a = (
      await post('/semesters', {
        academicYearId: y.id,
        number: 1,
        name: 'First (test)',
        startDate: '2030-08-15',
        endDate: '2030-12-20',
      }).expect(201)
    ).body;
    const b = (
      await post('/semesters', {
        academicYearId: y.id,
        number: 2,
        name: 'Second (test)',
        startDate: '2031-01-10',
        endDate: '2031-05-30',
      }).expect(201)
    ).body;

    await http.post(`/api/v1/semesters/${a.id}/activate`).set(admin).expect(200);
    const blocked = await http.post(`/api/v1/semesters/${b.id}/activate`).set(admin).expect(409);
    expect(blocked.body.code).toBe('ANOTHER_SEMESTER_ACTIVE');
    expect((await get('/academic-years').expect(200)).body[0].isCurrent).toBe(true);

    const locked = await patch(`/semesters/${a.id}`, { endDate: '2030-12-22' }).expect(409);
    expect(locked.body.code).toBe('SEMESTER_NOT_PLANNED');
    await http.post(`/api/v1/semesters/${a.id}/close`).set(admin).expect(200);
    await http.post(`/api/v1/semesters/${b.id}/activate`).set(admin).expect(200);
    await http.post(`/api/v1/semesters/${a.id}/activate`).set(admin).expect(409);
  });

  it('switches the current year', async () => {
    const y1 = await year('TEST-2030');
    const y2 = await year('TEST-2031', '2031-08-01', '2032-07-31');
    await http.post(`/api/v1/academic-years/${y1.id}/make-current`).set(admin).expect(200);
    await http.post(`/api/v1/academic-years/${y2.id}/make-current`).set(admin).expect(200);
    const years = (await get('/academic-years').expect(200)).body as { id: string; isCurrent: boolean }[];
    expect(years.filter((y) => y.isCurrent).map((y) => y.id)).toEqual([y2.id]);
  });

  it('is limited to university-wide administrators', async () => {
    const { auth } = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await post(
      '/academic-years',
      { label: 'TEST-X', startDate: '2040-01-01', endDate: '2040-12-31' },
      auth,
    ).expect(403);
  });
});

describe('calendar exceptions', () => {
  it('keeps entries inside their semester, lists by date and removes only future ones', async () => {
    const y = (
      await post('/academic-years', {
        label: 'TEST-2030',
        startDate: '2030-08-01',
        endDate: '2031-07-31',
      }).expect(201)
    ).body;
    const s = (
      await post('/semesters', {
        academicYearId: y.id,
        number: 1,
        name: 'First (test)',
        startDate: '2030-08-15',
        endDate: '2030-12-20',
      }).expect(201)
    ).body;

    await post('/calendar-exceptions', {
      semesterId: s.id,
      type: 'OTHER',
      name: 'Outside',
      startDate: '2031-01-01',
      endDate: '2031-01-02',
    }).expect(400);
    const holiday = (
      await post('/calendar-exceptions', {
        semesterId: s.id,
        type: 'PUBLIC_HOLIDAY',
        name: 'Test Holiday',
        startDate: '2030-09-21',
        endDate: '2030-09-21',
      }).expect(201)
    ).body;
    expect(holiday).toMatchObject({ startDate: '2030-09-21', suppressesClasses: true });

    const listed = (await get('/calendar-exceptions?from=2030-09-01&to=2030-09-30').expect(200)).body;
    expect(listed.map((e: { name: string }) => e.name)).toEqual(['Test Holiday']);
    expect((await get('/calendar-exceptions?from=2030-10-01').expect(200)).body).toHaveLength(0);

    await http.post(`/api/v1/calendar-exceptions/${holiday.id}/remove`).set(admin).send({}).expect(400);
    await http
      .post(`/api/v1/calendar-exceptions/${holiday.id}/remove`)
      .set(admin)
      .send({ reason: 'Entered by mistake (test)' })
      .expect(204);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'academic.calendar_exception.removed' },
    });
    expect(entry.reason).toBe('Entered by mistake (test)');
  });

  it('keeps entries that have already started', async () => {
    const past = (
      await post('/calendar-exceptions', {
        type: 'UNIVERSITY_CLOSURE',
        name: 'Past Closure',
        startDate: '2020-01-01',
        endDate: '2020-01-02',
      }).expect(201)
    ).body;
    const res = await http
      .post(`/api/v1/calendar-exceptions/${past.id}/remove`)
      .set(admin)
      .send({ reason: 'Trying to remove (test)' })
      .expect(409);
    expect(res.body.code).toBe('ALREADY_STARTED');
  });
});
