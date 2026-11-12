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
import { AttendanceSessionsService } from '../src/modules/attendance/attendance-sessions.service.js';
import { checkToken, parseToken } from '../src/modules/attendance/qr.js';
import { EncryptionService } from '../src/infrastructure/crypto/encryption.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Attendance sessions and the dynamic QR (Phase 5 step 1). Obviously fake data: one class on Tuesday
// 2030-08-20 10:00–11:30 (Africa/Accra = UTC). Students 1–3 enrolled before the class, student 4
// enrolled after it started, student 5 dropped before it, student 6 dropped after it started.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:55:00Z');
const at = (hhmmss: string) => clock.set(`2030-08-20T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}Z`);

let app: INestApplication;
let prisma: PrismaService;
let sessions: AttendanceSessionsService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let lecturer: Record<string, string>;
let otherLecturer: Record<string, string>;
let student: Record<string, string>;
let classId: string;
let studentIds: string[];
let studentUserIds: string[];

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
  sessions = app.get(AttendanceSessionsService);
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
  at('09:55');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  const adminId = signedIn.user.id;
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
  const course = await prisma.course.create({
    data: { code: 'TST101', title: 'Test Course', departmentId: dept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const lecturerUser = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  const otherUser = await createUser(prisma, {
    email: 'other.lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
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
  classId = (
    await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: profile.id,
        classroomId: room.id,
        scheduledStart: new Date('2030-08-20T10:00:00Z'),
        scheduledEnd: new Date('2030-08-20T11:30:00Z'),
        sections: { create: [{ sectionId: section.id }] },
      },
    })
  ).id;
  const enrolments: { enrolledAt: string; endedAt?: string }[] = [
    { enrolledAt: '2030-08-16T08:00:00Z' },
    { enrolledAt: '2030-08-16T08:00:00Z' },
    { enrolledAt: '2030-08-16T08:00:00Z' },
    { enrolledAt: '2030-08-20T10:30:00Z' },
    { enrolledAt: '2030-08-16T08:00:00Z', endedAt: '2030-08-19T08:00:00Z' },
    { enrolledAt: '2030-08-16T08:00:00Z', endedAt: '2030-08-20T10:40:00Z' },
  ];
  studentIds = [];
  studentUserIds = [];
  for (const [i, e] of enrolments.entries()) {
    const user = await createUser(prisma, {
      email: `student${i + 1}@example.test`,
      roles: ['STUDENT'],
      password: null,
    });
    const s = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: `9900000${i + 1}`,
        programmeId: programme.id,
        levelId: level.id,
        currentAcademicYearId: year.id,
        currentSemesterId: semester.id,
        registeredById: adminId,
      },
    });
    await prisma.courseEnrollment.create({
      data: {
        studentId: s.id,
        offeringId: offering.id,
        sectionId: section.id,
        createdById: adminId,
        enrolledAt: new Date(e.enrolledAt),
        ...(e.endedAt
          ? {
              status: 'DROPPED' as const,
              endedAt: new Date(e.endedAt),
              endedById: adminId,
              endReason: 'Dropped (test)',
            }
          : {}),
      },
    });
    studentIds.push(s.id);
    studentUserIds.push(user.id);
  }
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
  otherLecturer = await sessionFor(otherUser.id, 'LECTURER');
  student = await sessionFor(studentUserIds[0]!, 'STUDENT');
});

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const open = (auth = lecturer, body: object = {}) =>
  http.post(`/api/v1/class-sessions/${classId}/attendance/open`).set(auth).send(body);
const post = (path: string, auth: Record<string, string>, body: object = {}) =>
  http.post(`/api/v1${path}`).set(auth).send(body);
const classStatus = async () =>
  (await prisma.classSession.findUniqueOrThrow({ where: { id: classId } })).status;
const eventTypes = async () =>
  (
    await prisma.classEvent.findMany({ where: { classSessionId: classId }, orderBy: { occurredAt: 'asc' } })
  ).map((e) => e.type);
const records = () => prisma.attendanceRecord.findMany({ where: { classSessionId: classId } });

describe('opening attendance', () => {
  it('starts the class and opens attendance in one tap, and tells the enrolled students', async () => {
    const opened = (await open().expect(201)).body;
    expect(opened).toMatchObject({
      classSessionId: classId,
      status: 'OPEN',
      openedAt: '2030-08-20T09:55:00.000Z',
      lateAfter: '2030-08-20T10:15:00.000Z', // the scheduled start + 15 min
      closesAt: '2030-08-20T10:15:00.000Z', // opening + 20 min
      qrRotationSeconds: 15,
      policyVersion: 0,
    });
    expect(opened).not.toHaveProperty('qrSecretEnc');
    expect(await classStatus()).toBe('ACTIVE');
    expect(await eventTypes()).toEqual(['ATTENDANCE_OPENED', 'STARTED']);
    expect((await open().expect(409)).body.code).toBe('ATTENDANCE_ALREADY_OPENED');
    await waitFor(
      async () => (await prisma.notification.count({ where: { category: 'ATTENDANCE_OPEN' } })) >= 4,
      'attendance alerts',
    );
    const told = await prisma.notification.findMany({ where: { category: 'ATTENDANCE_OPEN' } });
    expect(told[0]!.title).toContain('attendance is open');
    expect(told.map((n) => n.userId)).toContain(studentUserIds[0]);
  });

  it('opens later for a running class, with lateness counted from the moment it opened', async () => {
    at('10:02');
    await post(`/class-sessions/${classId}/start`, lecturer).expect(200);
    at('10:30');
    expect(
      (await open(lecturer, { startClass: false, closeAfterMinutes: 10 }).expect(201)).body,
    ).toMatchObject({
      lateAfter: '2030-08-20T10:45:00.000Z',
      closesAt: '2030-08-20T10:40:00.000Z',
    });
  });

  it('only the class’s own lecturer opens it, within the class’s time', async () => {
    expect((await open(otherLecturer).expect(403)).body.code).toBe('NOT_YOUR_CLASS');
    await open(student).expect(403);
    expect((await open(lecturer, { startClass: false }).expect(409)).body.code).toBe('CLASS_NOT_STARTED');
    at('09:30');
    await open().expect(409); // too early to start the class
    expect(await prisma.attendanceSession.count()).toBe(0);
    expect(await classStatus()).toBe('SCHEDULED');
  });
});

describe('the rotating QR', () => {
  it('gives the lecturer a signed token that changes every 15 seconds', async () => {
    const opened = (await open().expect(201)).body;
    const first = (await http.get(`/api/v1/attendance-sessions/${opened.id}/qr`).set(lecturer).expect(200))
      .body;
    expect(first).toMatchObject({ window: 0, rotationSeconds: 15, expiresAt: '2030-08-20T09:55:15.000Z' });
    at('09:55:16');
    const second = (await http.get(`/api/v1/attendance-sessions/${opened.id}/qr`).set(lecturer).expect(200))
      .body;
    expect(second.window).toBe(1);
    expect(second.token).not.toBe(first.token);
    // The server's secret checks it; only the class's own lecturer may fetch it.
    const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: opened.id } });
    const secret = app.get(EncryptionService).decrypt(row.qrSecretEnc);
    expect(checkToken(parseToken(second.token)!, secret, 1, 1)).toEqual({ valid: true, window: 1 });
    expect(checkToken(parseToken(first.token)!, secret, 1, 1).valid).toBe(true); // one window of grace
    expect(checkToken(parseToken(first.token)!, secret, 2, 1)).toEqual({
      valid: false,
      reason: 'QR_EXPIRED',
    });
    await http.get(`/api/v1/attendance-sessions/${opened.id}/qr`).set(otherLecturer).expect(403);
    await http.get(`/api/v1/attendance-sessions/${opened.id}/qr`).set(student).expect(403);
  });
});

describe('closing attendance', () => {
  it('marks every student eligible at the scheduled start ABSENT if they have no record, once', async () => {
    const opened = (await open().expect(201)).body;
    at('10:05');
    const closed = (await post(`/attendance-sessions/${opened.id}/close`, lecturer).expect(200)).body;
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'MANUAL', counts: { ABSENT: 4 } });
    // Students 1–3, and 6 (dropped after the start); not 4 (joined later) or 5 (dropped before).
    const absent = (await records()).map((r) => r.studentId).sort();
    expect(absent).toEqual([studentIds[0], studentIds[1], studentIds[2], studentIds[5]].sort());
    expect((await post(`/attendance-sessions/${opened.id}/close`, lecturer).expect(409)).body.code).toBe(
      'ATTENDANCE_CLOSED',
    );
    expect(await eventTypes()).toContain('ATTENDANCE_CLOSED');
    expect(await prisma.auditLog.count({ where: { action: 'attendance.closed' } })).toBe(1);
    // Records are never deleted.
    await expect(prisma.attendanceRecord.deleteMany({})).rejects.toThrow();
  });

  it('closes by itself when its time is up, or when the class ends', async () => {
    const opened = (await open().expect(201)).body;
    at('10:14');
    expect(await sessions.sweep()).toEqual({ closed: 0, voided: 0 });
    at('10:15');
    expect(await sessions.sweep()).toEqual({ closed: 1, voided: 0 });
    expect((await prisma.attendanceSession.findUniqueOrThrow({ where: { id: opened.id } })).closeReason).toBe(
      'AUTO',
    );
    expect(await sessions.sweep()).toEqual({ closed: 0, voided: 0 }); // safe to repeat
    expect(await records()).toHaveLength(4);
  });

  it('closes when the class ends early', async () => {
    const opened = (await open(lecturer, { closeAfterMinutes: 60 }).expect(201)).body;
    at('10:10');
    await post(`/class-sessions/${classId}/end`, lecturer).expect(200);
    await sessions.sweep();
    expect((await prisma.attendanceSession.findUniqueOrThrow({ where: { id: opened.id } })).closeReason).toBe(
      'CLASS_ENDED',
    );
  });

  it('an administrator can force-close, with a reason; other lecturers cannot close it', async () => {
    const opened = (await open().expect(201)).body;
    await post(`/attendance-sessions/${opened.id}/close`, otherLecturer).expect(403);
    expect((await post(`/attendance-sessions/${opened.id}/close`, admin).expect(400)).body.code).toBe(
      'REASON_REQUIRED',
    );
    expect(
      (
        await post(`/attendance-sessions/${opened.id}/close`, admin, { reason: 'Fire drill (test)' }).expect(
          200,
        )
      ).body.closeReason,
    ).toBe('FORCED');
    expect(
      (await prisma.auditLog.findFirstOrThrow({ where: { action: 'attendance.force_closed' } })).reason,
    ).toBe('Fire drill (test)');
  });
});

describe('extending and reopening', () => {
  it('extends with a reason, within limits', async () => {
    const opened = (await open().expect(201)).body;
    const extended = (
      await post(`/attendance-sessions/${opened.id}/extend`, lecturer, {
        minutes: 10,
        reason: 'Late bus (test)',
      }).expect(200)
    ).body;
    expect(extended.closesAt).toBe('2030-08-20T10:25:00.000Z');
    await post(`/attendance-sessions/${opened.id}/extend`, lecturer, { minutes: 10 }).expect(400);
    await post(`/attendance-sessions/${opened.id}/extend`, otherLecturer, {
      minutes: 5,
      reason: 'Not mine (test)',
    }).expect(403);
    at('11:40');
    await sessions.sweep(); // closed at 10:25
    expect(
      (
        await post(`/attendance-sessions/${opened.id}/extend`, lecturer, {
          minutes: 5,
          reason: 'Too late (test)',
        }).expect(409)
      ).body.code,
    ).toBe('ATTENDANCE_CLOSED');
  });

  it('reopens once, with a reason, before the scheduled end; absences can still be raised later', async () => {
    const opened = (await open().expect(201)).body;
    at('10:05');
    await post(`/attendance-sessions/${opened.id}/close`, lecturer).expect(200);
    await post(`/attendance-sessions/${opened.id}/reopen`, lecturer, {}).expect(400);
    at('10:20');
    const reopened = (
      await post(`/attendance-sessions/${opened.id}/reopen`, lecturer, {
        reason: 'Projector was off (test)',
        minutes: 5,
      }).expect(200)
    ).body;
    expect(reopened).toMatchObject({
      status: 'OPEN',
      closesAt: '2030-08-20T10:25:00.000Z',
      reopenedAt: '2030-08-20T10:20:00.000Z',
      closeReason: null,
    });
    expect(await records()).toHaveLength(4); // the ABSENT records stay until a check-in raises them
    at('10:25');
    await sessions.sweep();
    expect(
      (
        await post(`/attendance-sessions/${opened.id}/reopen`, lecturer, { reason: 'Again (test)' }).expect(
          409,
        )
      ).body.code,
    ).toBe('ALREADY_REOPENED');
    expect(await eventTypes()).toEqual(
      expect.arrayContaining(['ATTENDANCE_OPENED', 'ATTENDANCE_CLOSED', 'ATTENDANCE_REOPENED']),
    );
  });
});

describe('voiding', () => {
  it('a class voided after attendance started has every record VOIDED, each with a correction', async () => {
    const opened = (await open().expect(201)).body;
    at('10:05');
    await post(`/attendance-sessions/${opened.id}/close`, lecturer).expect(200);
    await post(`/class-sessions/${classId}/void`, admin, {
      reason: 'Wrong group held the room (test)',
    }).expect(200);
    expect(await sessions.sweep()).toEqual({ closed: 0, voided: 1 });
    expect((await records()).every((r) => r.status === 'VOIDED')).toBe(true);
    const corrections = await prisma.attendanceCorrection.findMany();
    expect(corrections).toHaveLength(4);
    expect(corrections[0]).toMatchObject({ fromStatus: 'ABSENT', toStatus: 'VOIDED', source: 'VOID' });
    expect(await sessions.sweep()).toEqual({ closed: 0, voided: 0 }); // once
    expect(await eventTypes()).toContain('ATTENDANCE_VOIDED');
    await expect(
      prisma.attendanceCorrection.updateMany({ data: { reason: 'Changed (test)' } }),
    ).rejects.toThrow();
    // A voided class's attendance cannot be reopened.
    expect(
      (await post(`/attendance-sessions/${opened.id}/reopen`, lecturer, { reason: 'Try (test)' }).expect(409))
        .body.code,
    ).toBe('CLASS_VOIDED');
  });

  it('voiding while attendance is still open closes it and voids every eligible student', async () => {
    await open().expect(201);
    at('10:05');
    await post(`/class-sessions/${classId}/void`, admin, {
      reason: 'Wrong group held the room (test)',
    }).expect(200);
    expect(await sessions.sweep()).toEqual({ closed: 0, voided: 1 });
    const rows = await records();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'VOIDED')).toBe(true);
  });
});

describe('reading', () => {
  it('the lecturer and administrators in scope can read it; others cannot', async () => {
    expect(
      (await http.get(`/api/v1/class-sessions/${classId}/attendance`).set(lecturer).expect(200)).body.data,
    ).toBeNull();
    const opened = (await open().expect(201)).body;
    expect(
      (await http.get(`/api/v1/class-sessions/${classId}/attendance`).set(admin).expect(200)).body.data.id,
    ).toBe(opened.id);
    await http.get(`/api/v1/attendance-sessions/${opened.id}`).set(lecturer).expect(200);
    await http.get(`/api/v1/attendance-sessions/${opened.id}`).set(otherLecturer).expect(403);
    await http.get(`/api/v1/attendance-sessions/${opened.id}`).set(student).expect(403);
  });
});
