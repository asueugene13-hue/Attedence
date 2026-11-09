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
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data. The class meets on Tuesdays 10:00–11:30 (Africa/Accra = UTC); the first is
// 2030-08-20. Sessions are created directly here; generation is tested in class-sessions.test.ts.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-19T08:00:00Z');
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let lecturer: Record<string, string>;
let otherLecturer: Record<string, string>;
let student: Record<string, string>;
let sessionId: string;
let ids: Record<'faculty' | 'otherFaculty' | 'lecturer' | 'room' | 'section', string>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
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

async function sessionFor(userId: string, role: 'LECTURER' | 'STUDENT') {
  const { SessionService } = await import('../src/modules/auth/session.service.js');
  const { TokenService } = await import('../src/modules/auth/token.service.js');
  const { session } = await app.get(SessionService).create({
    userId,
    client: 'MOBILE',
    role,
    mfaVerified: false,
    context: { requestId: undefined, ip: undefined, userAgent: undefined },
  });
  const { token } = await app.get(TokenService).signAccess({ userId, sessionId: session.id, role });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  clock.set('2030-08-19T08:00:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const otherFaculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty' } });
  const dept = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
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
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const lecturerUser = await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
  const otherUser = await createUser(prisma, { email: 'other.lecturer@example.test', roles: ['LECTURER'] });
  const studentUser = await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
  const profile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  await prisma.lecturerProfile.create({
    data: { userId: otherUser.id, staffNumber: 'TL2', departmentId: dept.id },
  });
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)' },
  });
  const timetable = await prisma.timetable.create({
    data: { semesterId: semester.id, name: 'T (test)', version: 1, createdById: signedIn.user.id },
  });
  const entry = await prisma.timetableEntry.create({
    data: {
      timetableId: timetable.id,
      lecturerId: profile.id,
      classroomId: room.id,
      dayOfWeek: 2,
      startMinute: 600,
      endMinute: 690,
      effectiveFrom: new Date('2030-08-15'),
      effectiveTo: new Date('2030-12-20'),
      createdById: signedIn.user.id,
    },
  });
  const session = await prisma.classSession.create({
    data: {
      timetableEntryId: entry.id,
      lecturerId: profile.id,
      classroomId: room.id,
      scheduledStart: new Date('2030-08-20T10:00:00Z'),
      scheduledEnd: new Date('2030-08-20T11:30:00Z'),
      sections: { create: [{ sectionId: section.id }] },
    },
  });
  sessionId = session.id;
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
  otherLecturer = await sessionFor(otherUser.id, 'LECTURER');
  student = await sessionFor(studentUser.id, 'STUDENT');
  ids = {
    faculty: faculty.id,
    otherFaculty: otherFaculty.id,
    lecturer: profile.id,
    room: room.id,
    section: section.id,
  };
});

const act = (action: string, auth: Record<string, string>, body: object = {}) =>
  http.post(`/api/v1/class-sessions/${sessionId}/${action}`).set(auth).send(body);
const status = async () => (await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } })).status;

describe('lecturer actions', () => {
  it('confirms only their own class, once, and students cannot', async () => {
    expect((await act('confirm', lecturer).expect(200)).body.status).toBe('CONFIRMED');
    expect((await act('confirm', lecturer).expect(409)).body.code).toBe('TRANSITION_NOT_ALLOWED');
    expect(
      (await act('delay', otherLecturer, { minutes: 10, reason: 'Not mine (test)' }).expect(403)).body.code,
    ).toBe('NOT_YOUR_CLASS');
    await act('confirm', student).expect(403);
    await act('interrupt', student, { reason: 'Students cannot (test)' }).expect(403);
  });

  it('starts only within the start window, then interrupts, resumes and ends', async () => {
    clock.set('2030-08-20T09:30:00Z');
    expect((await act('start', lecturer).expect(409)).body.code).toBe('OUTSIDE_START_WINDOW');
    clock.set('2030-08-20T09:46:00Z');
    const started = (await act('start', lecturer).expect(200)).body;
    expect(started.status).toBe('ACTIVE');
    await act('interrupt', lecturer).expect(400);
    clock.set('2030-08-20T10:20:00Z');
    expect((await act('interrupt', lecturer, { reason: 'Power cut (test)' }).expect(200)).body.status).toBe(
      'INTERRUPTED',
    );
    clock.set('2030-08-20T10:40:00Z');
    expect((await act('resume', lecturer).expect(200)).body.status).toBe('ACTIVE');
    clock.set('2030-08-20T11:25:00Z');
    const ended = (await act('end', lecturer).expect(200)).body;
    expect(ended.status).toBe('COMPLETED');
    expect(ended.events.map((e: { type: string }) => e.type)).toEqual([
      'STARTED',
      'INTERRUPTED',
      'RESUMED',
      'ENDED',
    ]);
    const row = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.actualStart?.toISOString()).toBe('2030-08-20T09:46:00.000Z');
    expect(row.actualEnd?.toISOString()).toBe('2030-08-20T11:25:00.000Z');
  });

  it('reports a delay that still leaves 30 minutes, and no more', async () => {
    expect(
      (await act('delay', lecturer, { minutes: 61, reason: 'Traffic (test)' }).expect(409)).body.code,
    ).toBe('DELAY_TOO_LONG');
    const delayed = (await act('delay', lecturer, { minutes: 30, reason: 'Traffic (test)' }).expect(200))
      .body;
    expect(delayed).toMatchObject({ status: 'POSTPONED', expectedStart: '2030-08-20T10:30:00.000Z' });
    await act('delay', lecturer, { minutes: 10, reason: 'Again (test)' }).expect(409);
  });

  it('cancels with a reason; "absent without notice" is for administrators; "Other" needs a note', async () => {
    expect(
      (await act('cancel', lecturer, { reasonCode: 'LECTURER_ABSENT_NO_NOTICE' }).expect(403)).body.code,
    ).toBe('ADMIN_ONLY_REASON');
    await act('cancel', lecturer, { reasonCode: 'OTHER' }).expect(400);
    const cancelled = (await act('cancel', lecturer, { reasonCode: 'ILLNESS' }).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'ILLNESS' });
    expect(await prisma.auditLog.count({ where: { action: 'class_sessions.cancel' } })).toBe(1);
  });
});

describe('administrator actions', () => {
  it('holds and lifts a hold, opens a review, and the lecturer can still start from review', async () => {
    expect(
      (await act('suspend', admin, { reason: 'Building inspection (test)' }).expect(200)).body.status,
    ).toBe('SUSPENDED');
    await act('cancel', lecturer, { reasonCode: 'ILLNESS' }).expect(409);
    expect(
      (await act('lift-hold', admin, { reason: 'Inspection done (test)' }).expect(200)).body.status,
    ).toBe('SCHEDULED');
    expect(
      (await act('open-review', admin, { reason: 'Students report a problem (test)' }).expect(200)).body
        .status,
    ).toBe('UNDER_REVIEW');
    clock.set('2030-08-20T10:05:00Z');
    expect((await act('start', lecturer).expect(200)).body.status).toBe('ACTIVE');
  });

  it('reinstates a mistaken cancellation, but never a voided class', async () => {
    await act('cancel', admin, { reasonCode: 'LECTURER_ABSENT_NO_NOTICE' }).expect(200);
    const reinstated = (await act('reinstate', admin, { reason: 'Cancelled by mistake (test)' }).expect(200))
      .body;
    expect(reinstated).toMatchObject({ status: 'SCHEDULED', cancelReason: null, cancelNote: null });

    clock.set('2030-08-20T10:00:00Z');
    await act('start', lecturer).expect(200);
    clock.set('2030-08-20T10:30:00Z');
    await act('end', lecturer).expect(200);
    const voided = (await act('void', admin, { reason: 'Wrong group attended (test)' }).expect(200)).body;
    expect(voided).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'OTHER',
      cancelNote: 'Wrong group attended (test)',
    });
    expect((await act('reinstate', admin, { reason: 'Try (test)' }).expect(409)).body.code).toBe(
      'CANNOT_REINSTATE_VOIDED',
    );
  });

  it('refuses to reinstate into a room that has since been taken', async () => {
    await act('cancel', admin, { reasonCode: 'VENUE_UNAVAILABLE' }).expect(200);
    await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: (await prisma.lecturerProfile.findFirstOrThrow({ where: { staffNumber: 'TL2' } })).id,
        classroomId: ids.room,
        scheduledStart: new Date('2030-08-20T10:00:00Z'),
        scheduledEnd: new Date('2030-08-20T11:00:00Z'),
      },
    });
    expect((await act('reinstate', admin, { reason: 'Try again (test)' }).expect(409)).body.code).toBe(
      'SLOT_TAKEN',
    );
    expect(await status()).toBe('CANCELLED');
  });

  it('acts only within the administrator’s scope', async () => {
    const outside = (
      await signInAs(app, prisma, 'other.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.otherFaculty },
      })
    ).auth;
    await act('suspend', outside, { reason: 'Out of scope (test)' }).expect(403);
    const inside = (
      await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
        scope: { type: 'FACULTY', id: ids.faculty },
      })
    ).auth;
    await act('suspend', inside, { reason: 'In scope (test)' }).expect(200);
  });
});

describe('safety', () => {
  it('lets only one of two simultaneous changes through', async () => {
    const results = await Promise.all([
      act('confirm', lecturer),
      act('cancel', admin, { reasonCode: 'EMERGENCY' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.classEvent.count({ where: { classSessionId: sessionId } })).toBe(1);
  });

  it('records who did what, in the class history and the audit log', async () => {
    await act('delay', lecturer, { minutes: 15, reason: 'Previous class overran (test)' }).expect(200);
    const event = await prisma.classEvent.findFirstOrThrow({ where: { classSessionId: sessionId } });
    expect(event).toMatchObject({
      type: 'DELAY_REPORTED',
      fromStatus: 'SCHEDULED',
      toStatus: 'POSTPONED',
      actorType: 'USER',
    });
    expect(event.payload).toMatchObject({
      as: 'LECTURER',
      minutes: 15,
      reason: 'Previous class overran (test)',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'class_sessions.delay' } });
    expect(audit.reason).toBe('Previous class overran (test)');
  });
});
