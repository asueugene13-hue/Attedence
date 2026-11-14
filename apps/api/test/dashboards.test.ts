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
import { buildClass, inRoom, newPhone, registerPhone, signedCheckIn } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// The lecturer's dashboard (Phase 6 step 6): every number counted from real records. Obviously fake
// data: the fixture's class on 2030-08-20 10:00–11:30 with three students (Accra = UTC).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (hhmm: string) => clock.set(`2030-08-20T${hhmm}:00Z`);

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
  at('09:58');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
});

const dashboard = async (auth = c.lecturer.auth) =>
  (await http.get('/api/v1/me/lecturer-dashboard').set(auth).expect(200)).body;

describe('the lecturer’s dashboard', () => {
  it('shows nothing made up before a class, then counts what really happened', async () => {
    const empty = await dashboard();
    expect(empty).toMatchObject({
      waiting: { disputes: { count: 0, oldestWaitingSince: null }, checkIns: 0, corrections: { waiting: 0 } },
      excusedThisWeek: 0,
      minimumPercent: null,
    });
    expect(empty.sections).toEqual([
      expect.objectContaining({ sectionId: c.sectionId, students: 3, classesHeld: 0, percentage: null }),
    ]);

    // The class: student 1 present, student 2 absent, student 3 waiting (a new phone).
    at('10:00');
    const id = (
      await http
        .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
        .set(c.lecturer.auth)
        .send({ startClass: true })
        .expect(201)
    ).body.id;
    at('10:01');
    const qr = async () =>
      (await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(c.lecturer.auth).expect(200)).body
        .token as string;
    await signedCheckIn(http, clock, c.students[0]!, inRoom(await qr())).expect(200);
    const s2 = c.students[1]!;
    const s3 = c.students[2]!;
    const phone = newPhone();
    const deviceId = await registerPhone(http, s3.auth, phone);
    expect(
      (await signedCheckIn(http, clock, { ...s3, phone, deviceId }, inRoom(await qr())).expect(200)).body
        .recordStatus,
    ).toBe('PENDING');
    at('10:25');
    await http.post(`/api/v1/attendance-sessions/${id}/close`).set(c.lecturer.auth).send({}).expect(200);
    at('11:30');
    await http.post(`/api/v1/class-sessions/${c.classId}/end`).set(c.lecturer.auth).send({}).expect(200);

    // Student 2 disputes the absence.
    at('12:00');
    await http
      .post('/api/v1/disputes')
      .set(s2.auth)
      .send({ classSessionId: c.classId, reason: 'I was at the back of the room (test).' })
      .expect(201);
    let d = await dashboard();
    expect(d.waiting).toMatchObject({ disputes: { count: 1 }, checkIns: 1 });
    // 1 present ÷ (3 counted − 1 undecided) = 50%.
    expect(d.sections[0]).toMatchObject({ classesHeld: 1, percentage: 50 });

    // An administrator excuses student 2's class: it leaves the total; the lecturer sees only the count.
    const excuse = (
      await http
        .post('/api/v1/excuse-requests')
        .set(s2.auth)
        .send({
          category: 'MEDICAL',
          startDate: '2030-08-20',
          endDate: '2030-08-20',
          description: 'Clinic visit (test).',
        })
        .expect(201)
    ).body;
    await http
      .post(`/api/v1/excuse-requests/${excuse.id}/approve`)
      .set(c.admin.auth)
      .send({ classSessionIds: [c.classId] })
      .expect(200);
    d = await dashboard();
    expect(d.excusedThisWeek).toBe(1);
    expect(d.sections[0].percentage).toBe(100); // 1 ÷ (3 − 1 excused − 1 undecided)
    expect(JSON.stringify(d)).not.toContain('Clinic');

    // Another lecturer's dashboard has none of this.
    expect(await dashboard(c.otherLecturer.auth)).toMatchObject({
      waiting: { disputes: { count: 0 }, checkIns: 0 },
      excusedThisWeek: 0,
      sections: [],
    });
    expect((await http.get('/api/v1/me/lecturer-dashboard').set(s2.auth).expect(403)).body.code).toBe(
      'NOT_A_LECTURER',
    );
    expect(await prisma.attendanceRecord.count()).toBe(3);
  });
});
