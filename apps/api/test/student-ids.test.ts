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
import { buildClass, inRoom, signedCheckIn } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// The digital student ID (Phase 6 step 5). Obviously fake data (students 99000001–99000002).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let c: Awaited<ReturnType<typeof buildClass>>;

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
  clock.set('2030-08-20T09:58:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 2 });
});

const card = async (who = c.students[0]!) =>
  (await http.get('/api/v1/me/student-id').set(who.auth).expect(200)).body;
const check = (auth: Record<string, string>, code: string) =>
  http.post('/api/v1/student-ids/check').set(auth).send({ code });

describe('the digital student ID', () => {
  it('shows the card with a code that holds no personal data and identifies the student to staff', async () => {
    const s = c.students[0]!;
    const mine = await card();
    expect(mine.student).toMatchObject({ studentNumber: '99000001', status: 'ACTIVE', hasPhoto: false });
    expect(mine.code).toMatchObject({ refreshAfterSeconds: 30, expiresAt: '2030-08-20T09:58:45.000Z' });
    expect(mine.code.value).toMatch(/^ASID1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]+$/);
    expect(mine.code.value).not.toContain('99000001');
    expect(mine.code.value).not.toContain(s.profileId);

    const checked = (await check(c.lecturer.auth, mine.code.value).expect(200)).body;
    expect(checked).toMatchObject({
      result: 'GENUINE',
      photo: null,
      student: { id: s.profileId, studentNumber: '99000001', active: true },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'student_ids.checked' } });
    expect(audit).toMatchObject({
      entityType: 'student',
      entityId: s.profileId,
      actorUserId: c.lecturer.userId,
    });
    // Each card request gives a different code.
    expect((await card()).code.value).not.toBe(mine.code.value);
  });

  it('refuses expired, edited and attendance codes, and shows nobody', async () => {
    const mine = await card();
    clock.set('2030-08-20T09:58:46Z'); // 46 seconds later
    expect((await check(c.admin.auth, mine.code.value).expect(200)).body).toMatchObject({
      result: 'EXPIRED',
      student: null,
    });
    const fresh = (await card()).code.value as string;
    const edited = fresh.slice(0, -2) + (fresh.endsWith('AA') ? 'BB' : 'AA');
    expect((await check(c.admin.auth, edited).expect(200)).body).toMatchObject({
      result: 'NOT_GENUINE',
      student: null,
    });
    // Pretending another student's reference is not possible without the key either.
    const [, , exp, mac] = fresh.split('.');
    expect((await check(c.admin.auth, `ASID1.${'x'.repeat(22)}.${exp}.${mac}`).expect(200)).body.result).toBe(
      'NOT_GENUINE',
    );
    expect(await prisma.auditLog.count({ where: { action: 'student_ids.checked', entityId: null } })).toBe(3); // every check is logged, even the ones that identify nobody
    expect((await check(c.admin.auth, 'AS1.something.1.abc').expect(400)).body.code).toBe('NOT_AN_ID_CODE');
  });

  it('says when a genuine card belongs to a student who is not active', async () => {
    const s = c.students[1]!;
    await prisma.studentProfile.update({ where: { id: s.profileId }, data: { status: 'SUSPENDED' } });
    const mine = await card(s);
    expect(mine.student.status).toBe('SUSPENDED');
    expect((await check(c.lecturer.auth, mine.code.value).expect(200)).body).toMatchObject({
      result: 'GENUINE',
      student: { status: 'SUSPENDED', active: false },
    });
  });

  it('only staff check IDs; only students have one; a student ID is no use for checking in', async () => {
    const mine = await card();
    expect((await check(c.students[1]!.auth, mine.code.value).expect(403)).body.code).toBe('STAFF_ONLY');
    expect((await http.get('/api/v1/me/student-id').set(c.lecturer.auth).expect(403)).body.code).toBe(
      'NOT_A_STUDENT',
    );
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ startClass: true })
      .expect(201);
    const result = (await signedCheckIn(http, clock, c.students[0]!, inRoom(mine.code.value)).expect(200))
      .body;
    expect(result.outcome).toBe('REJECTED');
    expect(result.recordStatus).toBeNull();
  });
});
