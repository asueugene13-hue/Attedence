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
import { SessionGenerationService } from '../src/modules/class-sessions/session-generation.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake data. The semester runs Thursday 15 August to Friday 20 December 2030; Tuesdays from
// 2030-08-20. Africa/Accra is UTC all year, so 10:00 local is 10:00Z.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-01T08:00:00Z');
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let adminId: string;
let ids: Record<
  'semester' | 'sectionA' | 'lecturer' | 'lecturerUser' | 'room1' | 'room2' | 'studentUser',
  string
>;

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

beforeEach(async () => {
  clock.set('2030-08-01T08:00:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  adminId = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const dept = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
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
  await prisma.calendarException.create({
    data: {
      type: 'PUBLIC_HOLIDAY',
      name: 'Test Holiday',
      startDate: new Date('2030-09-03'),
      endDate: new Date('2030-09-03'),
      createdById: adminId,
    },
  });
  const course = await prisma.course.create({
    data: { code: 'TST101', title: 'Test Course', departmentId: dept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const sectionA = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const lecturerUser = await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
  const lecturer = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  await prisma.lecturerAssignment.create({
    data: { lecturerId: lecturer.id, sectionId: sectionA.id, assignedById: adminId },
  });
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room1 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)' },
  });
  const room2 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R2', name: 'Room 2 (test)' },
  });
  const studentUser = await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
  const student = await prisma.studentProfile.create({
    data: {
      userId: studentUser.id,
      studentNumber: '99000001',
      programmeId: programme.id,
      levelId: level.id,
      currentAcademicYearId: year.id,
      currentSemesterId: semester.id,
      registeredById: adminId,
    },
  });
  await prisma.courseEnrollment.create({
    data: { studentId: student.id, offeringId: offering.id, sectionId: sectionA.id, createdById: adminId },
  });
  ids = {
    semester: semester.id,
    sectionA: sectionA.id,
    lecturer: lecturer.id,
    lecturerUser: lecturerUser.id,
    room1: room1.id,
    room2: room2.id,
    studentUser: studentUser.id,
  };
});

const post = (path: string, body: object = {}) => http.post(`/api/v1${path}`).set(admin).send(body);
const get = (path: string, auth = admin) => http.get(`/api/v1${path}`).set(auth);
const weekly = (overrides: object = {}) => ({
  sectionIds: [ids.sectionA],
  lecturerId: ids.lecturer,
  classroomId: ids.room1,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:30',
  ...overrides,
});

/** Publishes a timetable and waits for its background generation job to finish. */
async function publishAndWait(timetableId: string) {
  await post(`/timetables/${timetableId}/publish`).expect(200);
  for (let i = 0; i < 200; i++) {
    const t = await prisma.timetable.findUniqueOrThrow({ where: { id: timetableId } });
    if (t.sessionsGeneratedAt) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Session generation did not finish');
}

async function firstVersion() {
  const t = (await post('/timetables', { semesterId: ids.semester, name: 'Semester 1 (test)' }).expect(201))
    .body;
  const entry = (await post(`/timetables/${t.id}/entries`, weekly()).expect(201)).body;
  await publishAndWait(t.id);
  return { timetable: t, entry };
}

describe('generating class sessions on publish', () => {
  it('creates one session per meeting, skipping holidays, in the university time zone', async () => {
    const { entry } = await firstVersion();
    const sessions = await prisma.classSession.findMany({
      where: { timetableEntryId: entry.id },
      orderBy: { scheduledStart: 'asc' },
      include: { sections: true },
    });
    expect(sessions).toHaveLength(17); // 18 Tuesdays, minus the 3 September holiday
    expect(sessions[0]).toMatchObject({
      status: 'SCHEDULED',
      kind: 'REGULAR',
      classroomId: ids.room1,
      lecturerId: ids.lecturer,
    });
    expect(sessions[0]!.scheduledStart.toISOString()).toBe('2030-08-20T10:00:00.000Z');
    expect(sessions[0]!.scheduledEnd.toISOString()).toBe('2030-08-20T11:30:00.000Z');
    expect(sessions.map((s) => s.scheduledStart.toISOString().slice(0, 10))).not.toContain('2030-09-03');
    expect(sessions[0]!.sections.map((s) => s.sectionId)).toEqual([ids.sectionA]);
    expect(await prisma.classEvent.count({ where: { type: 'GENERATED' } })).toBe(17);
  });

  it('is safe to run again: nothing is duplicated', async () => {
    const { timetable } = await firstVersion();
    const summary = await app.get(SessionGenerationService).generate(timetable.id, adminId);
    expect(summary).toEqual({
      created: 0,
      updated: 0,
      carriedOver: 0,
      cancelled: 0,
      reinstated: 0,
      notReinstated: 0,
      unchanged: 17,
    });
    expect(await prisma.classSession.count()).toBe(17);
  });

  it('only creates sessions that are still in the future', async () => {
    clock.set('2030-10-01T12:00:00Z');
    const { entry } = await firstVersion();
    const first = await prisma.classSession.findFirstOrThrow({
      where: { timetableEntryId: entry.id },
      orderBy: { scheduledStart: 'asc' },
    });
    expect(first.scheduledStart.toISOString()).toBe('2030-10-08T10:00:00.000Z');
  });
});

describe('a new timetable version', () => {
  it('carries future sessions over, updates what changed, adds new meetings, and leaves the past alone', async () => {
    const { entry: oldEntry } = await firstVersion();
    const before = await prisma.classSession.findMany({
      where: { timetableEntryId: oldEntry.id },
      orderBy: { scheduledStart: 'asc' },
    });

    // Two weeks into the semester, the class moves to room 2 and a one-time extra class is added.
    clock.set('2030-08-30T12:00:00Z');
    const v2 = (
      await post('/timetables', { semesterId: ids.semester, name: 'Semester 1, v2 (test)' }).expect(201)
    ).body;
    const copied = v2.entries[0];
    await http
      .patch(`/api/v1/timetable-entries/${copied.id}`)
      .set(admin)
      .set('If-Match', '0')
      .send(weekly({ classroomId: ids.room2 }))
      .expect(200);
    await post(
      `/timetables/${v2.id}/entries`,
      weekly({
        recurrence: 'ONCE',
        dayOfWeek: undefined,
        date: '2030-10-02',
        startTime: '14:00',
        endTime: '15:00',
      }),
    ).expect(201);
    await publishAndWait(v2.id);

    const after = await prisma.classSession.findMany({
      where: { kind: 'REGULAR' },
      orderBy: { scheduledStart: 'asc' },
    });
    expect(after).toHaveLength(18);
    // The two past sessions (20 and 27 August) are untouched: old entry, old room.
    expect(after.slice(0, 2).map((s) => [s.id, s.timetableEntryId, s.classroomId])).toEqual(
      before.slice(0, 2).map((s) => [s.id, oldEntry.id, ids.room1]),
    );
    // Future sessions are the same rows, now on the new entry and in room 2, with a venue-change event.
    const future = after.filter((s) => s.timetableEntryId === copied.id);
    expect(future).toHaveLength(15);
    expect(future.every((s) => s.classroomId === ids.room2)).toBe(true);
    expect(future.map((s) => s.id)).toEqual(before.slice(2).map((s) => s.id));
    expect(await prisma.classEvent.count({ where: { type: 'VENUE_CHANGED' } })).toBe(15);
    expect(after.filter((s) => s.scheduledStart.toISOString() === '2030-10-02T14:00:00.000Z')).toHaveLength(
      1,
    );
  });

  it('cancels future sessions of a removed entry as the publisher’s act, but never resurrects a cancelled class', async () => {
    const { entry } = await firstVersion();
    // The lecturer had already cancelled one class (simulated; the cancel action arrives in step 4).
    const target = await prisma.classSession.findFirstOrThrow({
      where: { timetableEntryId: entry.id, scheduledStart: new Date('2030-10-08T10:00:00Z') },
    });
    await prisma.classSession.update({
      where: { id: target.id },
      data: { status: 'CANCELLED', cancelReason: 'ILLNESS' },
    });

    const v2 = (await post('/timetables', { semesterId: ids.semester, name: 'v2 (test)' }).expect(201)).body;
    await publishAndWait(v2.id);
    expect((await prisma.classSession.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      'CANCELLED',
    );
    expect(
      await prisma.classSession.count({ where: { scheduledStart: new Date('2030-10-08T10:00:00Z') } }),
    ).toBe(1);

    const v3 = (await post('/timetables', { semesterId: ids.semester, name: 'v3 (test)' }).expect(201)).body;
    await post(`/timetable-entries/${v3.entries[0].id}/cancel`, { reason: 'Course withdrawn (test)' }).expect(
      200,
    );
    await post(`/timetables/${v3.id}/entries`, weekly({ dayOfWeek: 4 })).expect(201);
    await publishAndWait(v3.id);
    const cancelled = await prisma.classSession.findMany({
      where: { status: 'CANCELLED', cancelNote: 'Timetable changed' },
    });
    expect(cancelled).toHaveLength(16); // 17 Tuesdays, one already cancelled by the lecturer
    expect(cancelled.every((s) => s.cancelReason === 'OTHER' && s.cancelledById === adminId)).toBe(true);
    const event = await prisma.classEvent.findFirstOrThrow({ where: { type: 'CANCELLED' } });
    expect(event).toMatchObject({ actorType: 'USER', actorUserId: adminId });
  });
});

describe('database safeguards', () => {
  it('refuses to put two live sessions in one room at overlapping times', async () => {
    const { entry } = await firstVersion();
    const existing = await prisma.classSession.findFirstOrThrow({ where: { timetableEntryId: entry.id } });
    const otherLecturer = await createUser(prisma, { email: 'other.lecturer@example.test' });
    const dept = await prisma.department.findFirstOrThrow();
    const lecturer2 = await prisma.lecturerProfile.create({
      data: { userId: otherLecturer.id, staffNumber: 'TL2', departmentId: dept.id },
    });
    await expect(
      prisma.classSession.create({
        data: {
          kind: 'MAKEUP',
          lecturerId: lecturer2.id,
          classroomId: ids.room1,
          scheduledStart: new Date(existing.scheduledStart.getTime() + 30 * 60_000),
          scheduledEnd: new Date(existing.scheduledEnd.getTime() + 30 * 60_000),
        },
      }),
    ).rejects.toThrow(/class_sessions_room_no_overlap|exclusion/);
  });

  it('keeps class history append-only', async () => {
    await firstVersion();
    const event = await prisma.classEvent.findFirstOrThrow();
    await expect(
      prisma.classEvent.update({ where: { id: event.id }, data: { payload: { tampered: true } } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('reading sessions', () => {
  it('lists sessions by date range and filters, and shows one with its history', async () => {
    await firstVersion();
    const list = (
      await get(`/class-sessions?from=2030-08-01&to=2030-08-31&sectionId=${ids.sectionA}`).expect(200)
    ).body.data;
    expect(list.map((s: { scheduledStart: string }) => s.scheduledStart)).toEqual([
      '2030-08-20T10:00:00.000Z',
      '2030-08-27T10:00:00.000Z',
    ]);
    expect(list[0]).toMatchObject({
      status: 'SCHEDULED',
      classroom: { code: 'R1' },
      sections: [{ code: 'A', course: { code: 'TST101' } }],
    });
    const one = (await get(`/class-sessions/${list[0].id}`).expect(200)).body;
    expect(one.events.map((e: { type: string }) => e.type)).toEqual(['GENERATED']);
    await get('/class-sessions?from=2030-08-01&to=2030-12-31').expect(400);
  });

  it('shows students and lecturers their own timetable', async () => {
    await firstVersion();
    const student = await signInSession(ids.studentUser, 'STUDENT');
    const mine = (await get('/me/timetable?from=2030-08-19&to=2030-08-25', student).expect(200)).body;
    expect(mine).toMatchObject({ as: 'STUDENT' });
    expect(mine.data).toHaveLength(1);
    const lecturer = await signInSession(ids.lecturerUser, 'LECTURER');
    expect(
      (await get('/me/timetable?from=2030-08-19&to=2030-09-08', lecturer).expect(200)).body.data,
    ).toHaveLength(2);
    expect((await get('/me/timetable?from=2030-08-19&to=2030-08-25', admin).expect(200)).body).toEqual({
      as: 'NONE',
      data: [],
    });
  });
});

describe('holidays added or removed after publishing', () => {
  const HOLIDAY_START = new Date('2030-10-15T10:00:00Z'); // a Tuesday class

  async function superAdmin() {
    return (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
  }
  const atHoliday = (entryId: string) =>
    prisma.classSession.findFirstOrThrow({
      where: { timetableEntryId: entryId, scheduledStart: HOLIDAY_START },
    });
  /** The calendar job runs in the background; wait until the class reaches the expected state. */
  async function waitUntil(check: () => Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('The calendar change was not applied');
  }
  async function addHoliday(auth: Record<string, string>) {
    const body = {
      type: 'PUBLIC_HOLIDAY',
      name: 'Test Holiday (fake)',
      startDate: '2030-10-15',
      endDate: '2030-10-15',
    };
    return (await http.post('/api/v1/calendar-exceptions').set(auth).send(body).expect(201)).body;
  }
  const removeHoliday = (auth: Record<string, string>, id: string) =>
    http
      .post(`/api/v1/calendar-exceptions/${id}/remove`)
      .set(auth)
      .send({ reason: 'Entered by mistake (test)' })
      .expect(204);

  it('cancels that day’s classes as a public holiday, and brings them back when it is removed', async () => {
    const { entry } = await firstVersion();
    const sa = await superAdmin();
    const holiday = await addHoliday(sa);
    await waitUntil(async () => (await atHoliday(entry.id)).status === 'CANCELLED');
    expect(await atHoliday(entry.id)).toMatchObject({
      cancelReason: 'PUBLIC_HOLIDAY',
      cancelNote: 'No classes: Test Holiday (fake)',
      cancelledByTimetableChange: true,
    });
    // Other weeks are untouched.
    expect(await prisma.classSession.count({ where: { status: 'CANCELLED' } })).toBe(1);

    await removeHoliday(sa, holiday.id);
    await waitUntil(async () => (await atHoliday(entry.id)).status === 'SCHEDULED');
    const back = await atHoliday(entry.id);
    expect(back).toMatchObject({ cancelReason: null, cancelNote: null, cancelledByTimetableChange: false });
    const events = await prisma.classEvent.findMany({
      where: { classSessionId: back.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['GENERATED', 'CANCELLED', 'REINSTATED']);
  });

  it('never brings back a class a person cancelled, nor one whose room was booked meanwhile', async () => {
    const { entry } = await firstVersion();
    const sa = await superAdmin();
    const byLecturer = await atHoliday(entry.id);
    await prisma.classSession.update({
      where: { id: byLecturer.id },
      data: { status: 'CANCELLED', cancelReason: 'ILLNESS' },
    });
    const nextWeek = new Date('2030-10-22T10:00:00Z');
    const holiday = (
      await http
        .post('/api/v1/calendar-exceptions')
        .set(sa)
        .send({
          type: 'UNIVERSITY_CLOSURE',
          name: 'Closure (fake)',
          startDate: '2030-10-15',
          endDate: '2030-10-22',
        })
        .expect(201)
    ).body;
    const closed = () =>
      prisma.classSession.findFirstOrThrow({
        where: { timetableEntryId: entry.id, scheduledStart: nextWeek },
      });
    await waitUntil(async () => (await closed()).status === 'CANCELLED');
    expect(await closed()).toMatchObject({
      cancelReason: 'INSTITUTION_EVENT',
      cancelNote: 'No classes: Closure (fake)',
    });
    expect(await atHoliday(entry.id)).toMatchObject({
      cancelReason: 'ILLNESS',
      cancelledByTimetableChange: false,
    });

    // While the closure stood, someone else's class took the room on the 22nd.
    const otherUser = await createUser(prisma, { email: 'other.lecturer@example.test', roles: ['LECTURER'] });
    const lecturerRow = await prisma.lecturerProfile.findUniqueOrThrow({ where: { id: ids.lecturer } });
    const other = await prisma.lecturerProfile.create({
      data: { userId: otherUser.id, staffNumber: 'TL9', departmentId: lecturerRow.departmentId },
    });
    await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: other.id,
        classroomId: ids.room1,
        scheduledStart: nextWeek,
        scheduledEnd: new Date('2030-10-22T11:00:00Z'),
      },
    });

    await removeHoliday(sa, holiday.id);
    // Both calendar jobs (adding and removing the closure) have finished.
    await waitUntil(
      async () =>
        (await prisma.backgroundJobRecord.count({
          where: { name: 'calendar-changed', status: 'SUCCEEDED' },
        })) === 2,
    );
    expect((await atHoliday(entry.id)).status).toBe('CANCELLED'); // the lecturer's cancellation stands
    expect((await closed()).status).toBe('CANCELLED'); // the room is taken now
  });
});

/** A session for an existing account (signInAs creates a new one). */
async function signInSession(userId: string, role: 'STUDENT' | 'LECTURER') {
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
