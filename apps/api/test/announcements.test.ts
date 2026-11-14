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
import { buildClass, type Student } from './attendance-fixture.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Announcements (Phase 6 step 4). Obviously fake data: the attendance fixture's two sections of one
// department (students 1–3 in section A, an outsider in the other section), on 2030-08-20 (Accra = UTC).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:00:00Z');

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let c: Awaited<ReturnType<typeof buildClass>>;
let outsider: Student;

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
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  clock.set('2030-08-20T09:00:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
  outsider = await c.addStudent(9, { sectionId: c.otherSectionId });
});

const send = (auth: Record<string, string>, body: object) =>
  http
    .post('/api/v1/announcements')
    .set(auth)
    .send({ title: 'Room change (test)', body: 'Hello (test).', ...body });
const toSection = (auth: Record<string, string>, extra: object = {}) =>
  send(auth, { scope: 'SECTION', sectionIds: [c.sectionId], ...extra });
const feed = async (s: Student) =>
  (await http.get('/api/v1/me/announcements').set(s.auth).expect(200)).body.data;

async function makeRep(s: Student) {
  await prisma.courseRepAssignment.create({
    data: {
      studentId: s.profileId,
      sectionId: c.sectionId,
      status: 'ACTIVE',
      assignedById: c.admin.userId,
      startsAt: new Date('2030-08-16T08:00:00Z'),
    },
  });
}

describe('a lecturer’s announcement', () => {
  it('reaches the section’s students only, is read and counted, and is kept as plain text', async () => {
    const targets = (await http.get('/api/v1/announcements/targets').set(c.lecturer.auth).expect(200)).body;
    expect(targets).toMatchObject({ kind: 'OFFICIAL', institution: false });
    expect(targets.sections).toEqual([expect.objectContaining({ id: c.sectionId, students: 3 })]);

    // A student who has not activated their account yet still receives it; a deferred student does not.
    await prisma.user.update({
      where: { id: c.students[2]!.userId },
      data: { status: 'PENDING_ACTIVATION' },
    });
    await prisma.studentProfile.update({
      where: { id: c.students[1]!.profileId },
      data: { status: 'DEFERRED' },
    });
    const sent = (
      await toSection(c.lecturer.auth, { body: 'Bring <b>drafts</b> & notes (test).', email: true }).expect(
        201,
      )
    ).body;
    expect(sent).toMatchObject({ kind: 'OFFICIAL', emailed: true, counts: { recipients: 2, read: 0 } });
    expect(await prisma.notification.count({ where: { category: 'ANNOUNCEMENT_EMAILED' } })).toBe(2);
    expect(await feed(c.students[1]!)).toEqual([]);
    expect(await feed(outsider)).toEqual([]);

    const s = c.students[0]!;
    const [item] = await feed(s);
    expect(item).toMatchObject({
      id: sent.id,
      kind: 'OFFICIAL',
      read: false,
      body: 'Bring <b>drafts</b> & notes (test).',
    });
    expect(item.audience).toContain('· A');
    expect(
      (await http.get('/api/v1/me/announcements/unread-count').set(s.auth).expect(200)).body.unread,
    ).toBe(1);
    await http.post(`/api/v1/me/announcements/${sent.id}/read`).set(s.auth).expect(200);
    expect(
      (await http.get('/api/v1/me/announcements/unread-count').set(s.auth).expect(200)).body.unread,
    ).toBe(0);
    await http.post(`/api/v1/me/announcements/${sent.id}/read`).set(outsider.auth).expect(404);

    const stats = (await http.get(`/api/v1/announcements/${sent.id}/stats`).set(c.lecturer.auth).expect(200))
      .body;
    expect(stats.counts).toMatchObject({ recipients: 2, read: 1 });
    await http.get(`/api/v1/announcements/${sent.id}/stats`).set(s.auth).expect(404);
    expect((await http.get('/api/v1/announcements').set(c.lecturer.auth).expect(200)).body.data).toHaveLength(
      1,
    );
    expect(await prisma.auditLog.count({ where: { action: 'announcements.sent', entityId: sent.id } })).toBe(
      1,
    );
  });

  it('only to sections the lecturer teaches', async () => {
    expect(
      (await send(c.lecturer.auth, { scope: 'SECTION', sectionIds: [c.otherSectionId] }).expect(403)).body
        .code,
    ).toBe('NOT_YOUR_SECTION');
    const dept = await prisma.department.findFirstOrThrow();
    await send(c.lecturer.auth, { scope: 'DEPARTMENT', departmentId: dept.id }).expect(403);
    await send(c.lecturer.auth, { scope: 'SECTION' }).expect(400); // no sections chosen
    await toSection(c.lecturer.auth, { title: '' }).expect(400);
  });
});

describe('a course rep’s update', () => {
  it('goes to their own section, is labelled, and is limited to 3 a day', async () => {
    const rep = c.students[1]!;
    expect((await toSection(rep.auth).expect(403)).body.code).toBe('NOT_COURSE_REP');
    await makeRep(rep);
    let targets = (await http.get('/api/v1/announcements/targets').set(rep.auth).expect(200)).body;
    expect(targets).toMatchObject({ kind: 'COURSE_REP', dailyLimit: 3 });
    expect(targets.sections[0]).toMatchObject({ id: c.sectionId, remainingToday: 3 });

    const first = (await toSection(rep.auth).expect(201)).body;
    expect(first.kind).toBe('COURSE_REP');
    expect(
      await prisma.notification.count({
        where: { category: 'ANNOUNCEMENT', title: { startsWith: 'Course rep update' } },
      }),
    ).toBe(3);
    clock.set('2030-08-20T15:00:00Z');
    await toSection(rep.auth).expect(201);
    await toSection(rep.auth).expect(201);
    targets = (await http.get('/api/v1/announcements/targets').set(rep.auth).expect(200)).body;
    expect(targets.sections[0].remainingToday).toBe(0);
    expect((await toSection(rep.auth).expect(409)).body.code).toBe('REP_LIMIT_REACHED');
    const dept = await prisma.department.findFirstOrThrow();
    await send(rep.auth, { scope: 'DEPARTMENT', departmentId: dept.id }).expect(403);
    clock.set('2030-08-21T00:01:00Z'); // a new day in Accra
    await toSection(rep.auth).expect(201);
    expect(
      (await feed(c.students[0]!)).filter((a: { kind: string }) => a.kind === 'COURSE_REP'),
    ).toHaveLength(4);
  });
});

describe('an administrator’s announcement', () => {
  it('to a department, or to everyone, within their scope', async () => {
    const dept = await prisma.department.findFirstOrThrow();
    const toDept = (await send(c.admin.auth, { scope: 'DEPARTMENT', departmentId: dept.id }).expect(201))
      .body;
    expect(toDept.counts.recipients).toBe(4); // both sections' students, same department
    const all = (await send(c.admin.auth, { scope: 'INSTITUTION' }).expect(201)).body;
    expect(all.audience).toBe('All students');
    const targets = (await http.get('/api/v1/announcements/targets').set(c.admin.auth).expect(200)).body;
    expect(targets).toMatchObject({ institution: true });
    expect(targets.departments.map((d: { id: string }) => d.id)).toContain(dept.id);

    const faculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty (test)' } });
    const other = await prisma.department.create({
      data: { facultyId: faculty.id, code: 'OD', name: 'Other Department (test)' },
    });
    const limited = await signInAs(app, prisma, 'admin.other@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: other.id },
    });
    await send(limited.auth, { scope: 'DEPARTMENT', departmentId: dept.id }).expect(403);
    await send(limited.auth, { scope: 'INSTITUTION' }).expect(403);
    expect(
      (await send(limited.auth, { scope: 'DEPARTMENT', departmentId: other.id }).expect(409)).body.code,
    ).toBe('NO_RECIPIENTS');
  });
});

describe('reporting and hiding', () => {
  it('a recipient reports once; the section’s lecturer is told, hides it with a reason, and it leaves feeds', async () => {
    const rep = c.students[1]!;
    await makeRep(rep);
    const post = (await toSection(rep.auth, { title: 'Party tonight (test)' }).expect(201)).body;
    const s = c.students[0]!;
    await http
      .post(`/api/v1/announcements/${post.id}/report`)
      .set(s.auth)
      .send({ reason: 'Not about the course (test)' })
      .expect(200);
    expect(
      (
        await http
          .post(`/api/v1/announcements/${post.id}/report`)
          .set(s.auth)
          .send({ reason: 'Again (test)' })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_REPORTED');
    await http
      .post(`/api/v1/announcements/${post.id}/report`)
      .set(outsider.auth)
      .send({ reason: 'Not mine (test)' })
      .expect(404);
    expect(
      await prisma.notification.count({
        where: { userId: c.lecturer.userId, category: 'ANNOUNCEMENT_REPORTED' },
      }),
    ).toBe(1);

    const reported = (await http.get('/api/v1/announcements?view=REPORTED').set(c.lecturer.auth).expect(200))
      .body.data;
    expect(reported).toEqual([
      expect.objectContaining({
        id: post.id,
        reports: [expect.objectContaining({ reason: 'Not about the course (test)' })],
      }),
    ]);
    expect(
      (await http.get('/api/v1/announcements?view=REPORTED').set(c.otherLecturer.auth).expect(200)).body.data,
    ).toEqual([]);
    await http
      .post(`/api/v1/announcements/${post.id}/hide`)
      .set(c.otherLecturer.auth)
      .send({ reason: 'Not mine (test)' })
      .expect(403);
    await http
      .post(`/api/v1/announcements/${post.id}/hide`)
      .set(rep.auth)
      .send({ reason: 'Undo my own (test)' })
      .expect(403);
    await http.post(`/api/v1/announcements/${post.id}/hide`).set(c.lecturer.auth).send({}).expect(400);
    const hidden = (
      await http
        .post(`/api/v1/announcements/${post.id}/hide`)
        .set(c.lecturer.auth)
        .send({ reason: 'Off-topic (test)' })
        .expect(200)
    ).body;
    expect(hidden).toMatchObject({ status: 'HIDDEN', hiddenReason: 'Off-topic (test)' });
    expect(await feed(s)).toEqual([]);
    expect(
      await prisma.auditLog.count({ where: { action: 'announcements.hidden', entityId: post.id } }),
    ).toBe(1);
    await expect(prisma.announcementReport.deleteMany({})).rejects.toThrow();
  });
});
