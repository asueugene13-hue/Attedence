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
import { buildClass, inRoom, signedCheckIn, type Student } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// History and percentages (Phase 5 step 5) and TESTING.md scenario 21 (a cancelled class is excluded).
// Obviously fake data. Section A meets: Tue 20 Aug 10:00 (held, attendance taken), Wed 21 Aug (held,
// no attendance taken), Thu 22 Aug (cancelled), Tue 27 Aug (still to come). Student 4 enrolled on
// 21 Aug, after the first class.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso.length === 5 ? `2030-08-20T${iso}:00Z` : iso);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let c: Awaited<ReturnType<typeof buildClass>>;
let late: Student;
let offeringId: string;
const extra: Record<string, string> = {};

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
  late = await c.addStudent(4, { enrolledAt: '2030-08-21T08:00:00Z' });
  offeringId = (await prisma.courseSection.findUniqueOrThrow({ where: { id: c.sectionId } })).offeringId;
  const base = await prisma.classSession.findUniqueOrThrow({ where: { id: c.classId } });
  const meeting = async (day: string, status: 'COMPLETED' | 'CANCELLED' | 'SCHEDULED') =>
    (
      await prisma.classSession.create({
        data: {
          kind: 'MAKEUP',
          lecturerId: base.lecturerId,
          classroomId: base.classroomId,
          scheduledStart: new Date(`2030-08-${day}T10:00:00Z`),
          scheduledEnd: new Date(`2030-08-${day}T11:30:00Z`),
          status,
          ...(status === 'CANCELLED' ? { cancelReason: 'ILLNESS' as const } : {}),
          sections: { create: [{ sectionId: c.sectionId }] },
        },
      })
    ).id;
  extra.noAttendance = await meeting('21', 'COMPLETED');
  extra.cancelled = await meeting('22', 'CANCELLED');
  extra.upcoming = await meeting('27', 'SCHEDULED');

  // The first class: student 1 on time, student 2 late, student 3 absent; then it ends.
  const attendanceId = (
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ closeAfterMinutes: 30 })
      .expect(201)
  ).body.id;
  const qr = async () =>
    (await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(c.lecturer.auth).expect(200)).body
      .token;
  at('10:01');
  await signedCheckIn(http, clock, c.students[0]!, inRoom(await qr())).expect(200);
  at('10:20');
  await signedCheckIn(http, clock, c.students[1]!, inRoom(await qr())).expect(200);
  at('10:25');
  await http
    .post(`/api/v1/attendance-sessions/${attendanceId}/close`)
    .set(c.lecturer.auth)
    .send({})
    .expect(200);
  at('11:30');
  await http.post(`/api/v1/class-sessions/${c.classId}/end`).set(c.lecturer.auth).expect(200);
  at('2030-08-23T09:00:00Z');
});

const mine = async (s: Student) => (await http.get('/api/v1/me/attendance').set(s.auth).expect(200)).body;
const course = async (s: Student) =>
  (await http.get(`/api/v1/me/attendance/offerings/${offeringId}`).set(s.auth).expect(200)).body;
const setMinimum = (value: number | null) =>
  prisma.institutionSetting.upsert({
    where: { key: 'attendance.minimumPercent' },
    create: {
      key: 'attendance.minimumPercent',
      value: value as never,
      version: 1,
      updatedById: c.admin.userId,
    },
    update: { value: value as never },
  });

describe('a student’s own attendance', () => {
  it('counts only the class that was held with attendance taken', async () => {
    const first = (await mine(c.students[0]!)).data[0];
    expect(first).toMatchObject({
      course: { code: 'TST101' },
      eligible: 1,
      present: 1,
      late: 0,
      absences: 0,
      cancelled: 1,
      percentage: 100,
      warning: null,
    });
    expect((await mine(c.students[1]!)).data[0]).toMatchObject({ late: 1, percentage: 100 }); // late counts as attended by default
    expect((await mine(c.students[2]!)).data[0]).toMatchObject({ absences: 1, percentage: 0 });
  });

  it('scenario 21: the cancelled class is listed but never counted', async () => {
    const detail = await course(c.students[2]!);
    const byClass = Object.fromEntries(
      detail.classes.map((x: { classSessionId: string }) => [x.classSessionId, x]),
    );
    expect(byClass[c.classId]).toMatchObject({ counted: true, outcome: 'ABSENT', record: 'ABSENT' });
    expect(byClass[extra.cancelled!]).toMatchObject({ counted: false, notCounted: 'CANCELLED' });
    expect(byClass[extra.noAttendance!]).toMatchObject({ counted: false, notCounted: 'NO_ATTENDANCE_TAKEN' });
    expect(byClass[extra.upcoming!]).toMatchObject({ counted: false, notCounted: 'NOT_HELD_YET' });
    expect(detail).toMatchObject({ eligible: 1, absences: 1, cancelled: 1 });
  });

  it('a student who enrolled later is not counted for classes before they joined', async () => {
    const detail = await course(late);
    expect(
      detail.classes.find((x: { classSessionId: string }) => x.classSessionId === c.classId),
    ).toMatchObject({ counted: false, notCounted: 'NOT_ENROLLED_YET' });
    expect(detail).toMatchObject({ eligible: 0, percentage: null });
  });

  it('a correction shows at once', async () => {
    const r = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { classSessionId_studentId: { classSessionId: c.classId, studentId: c.students[2]!.profileId } },
    });
    await http
      .post(`/api/v1/attendance-records/${r.id}/correct`)
      .set(c.lecturer.auth)
      .send({ status: 'PRESENT', reason: 'Signed the paper register (test)', version: r.version })
      .expect(200);
    expect((await mine(c.students[2]!)).data[0].percentage).toBe(100);
  });

  it('the warning appears only once a minimum is set, with the absences still possible', async () => {
    expect((await mine(c.students[2]!)).minimumPercent).toBeNull();
    await setMinimum(75);
    const absent = (await mine(c.students[2]!)).data[0];
    // 0 of 1 so far, 1 class to come: even attending it ends at 50%.
    expect(absent.warning).toEqual({
      minimumPercent: 75,
      belowMinimum: true,
      absencesAllowed: 0,
      remainingClasses: 1,
    });
    expect((await mine(c.students[0]!)).data[0].warning).toMatchObject({
      belowMinimum: false,
      absencesAllowed: 0,
    });
  });

  it('only students have their own history', async () => {
    await http.get('/api/v1/me/attendance').set(c.lecturer.auth).expect(403);
    await http.get(`/api/v1/me/attendance/offerings/${offeringId}`).set(c.students[0]!.auth).expect(200);
    const other = await c.addStudent(9, { sectionId: c.otherSectionId });
    await http.get(`/api/v1/me/attendance/offerings/${offeringId}`).set(other.auth).expect(404);
  });
});

describe('a section’s attendance', () => {
  it('its lecturer and administrators see every student; others cannot', async () => {
    const summary = (
      await http
        .get(`/api/v1/course-sections/${c.sectionId}/attendance-summary`)
        .set(c.lecturer.auth)
        .expect(200)
    ).body;
    expect(summary).toMatchObject({
      section: { code: 'A', course: { code: 'TST101' } },
      classesHeld: 2,
      minimumPercent: null,
    });
    expect(summary.data).toHaveLength(4);
    const byNumber = Object.fromEntries(
      summary.data.map((s: { studentNumber: string }) => [s.studentNumber, s]),
    );
    expect(byNumber['99000001']).toMatchObject({ percentage: 100 });
    expect(byNumber['99000003']).toMatchObject({ percentage: 0, absences: 1 });
    expect(byNumber['99000004']).toMatchObject({ eligible: 0, percentage: null });
    await http.get(`/api/v1/course-sections/${c.sectionId}/attendance-summary`).set(c.admin.auth).expect(200);
    await http
      .get(`/api/v1/course-sections/${c.sectionId}/attendance-summary`)
      .set(c.otherLecturer.auth)
      .expect(403);
    await http
      .get(`/api/v1/course-sections/${c.sectionId}/attendance-summary`)
      .set(c.students[0]!.auth)
      .expect(403);
  });
});
