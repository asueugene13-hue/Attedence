import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Check-in (Phase 5 step 2), TESTING.md scenarios 1–9, 11, 12 and a burst toward 25. Obviously fake
// data: a made-up site, one class on Tuesday 2030-08-20 10:00–11:30 in room R1 with a calibrated
// beacon, room R2 next door with its own beacon. Students have signed, trusted phones.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (hhmmss: string) => clock.set(`2030-08-20T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}Z`);
const SITE = { lat: 5.6, lng: -0.18 };
const north = (m: number, accuracyM = 15) => ({
  latitude: SITE.lat + m / 111_195,
  longitude: SITE.lng,
  accuracyM,
});
const R1_UID = '0123456789abcdef0123456789abcd01';
const R2_UID = '0123456789abcdef0123456789abcd02';

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let lecturer: Record<string, string>;
let classId: string;
let beaconId: string;
let attendanceId: string;

interface Phone {
  installationId: string;
  privateKey: KeyObject;
  publicKey: string;
}
interface Student {
  auth: Record<string, string>;
  phone: Phone;
  deviceId: string;
  profileId: string;
}
let students: Student[];
let otherCourseStudent: Student;

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

function newPhone(installationId = randomUUID()): Phone {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { installationId, privateKey, publicKey: publicKey.export({ format: 'jwk' }).x as string };
}

async function registerPhone(auth: Record<string, string>, phone: Phone): Promise<string> {
  return (
    await http
      .post('/api/v1/me/devices')
      .set(auth)
      .send({ installationId: phone.installationId, platform: 'ANDROID', publicKey: phone.publicKey })
      .expect(200)
  ).body.id;
}

beforeEach(async () => {
  at('09:58');
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
  const otherCourse = await prisma.course.create({
    data: { code: 'TST102', title: 'Other Test Course', departmentId: dept.id },
  });
  const offering = await prisma.courseOffering.create({
    data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
  });
  const otherOffering = await prisma.courseOffering.create({
    data: { courseId: otherCourse.id, semesterId: semester.id, status: 'OPEN' },
  });
  const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
  const otherSection = await prisma.courseSection.create({
    data: { offeringId: otherOffering.id, code: 'A' },
  });
  const lecturerUser = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  const profile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  const campus = await prisma.campus.create({
    data: {
      code: 'TC',
      name: 'Test Campus',
      geofenceLat: SITE.lat,
      geofenceLng: SITE.lng,
      geofenceRadiusM: 200,
    },
  });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R1', name: 'Room 1 (test)' },
  });
  const room2 = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R2', name: 'Room 2 (test)' },
  });
  beaconId = (
    await prisma.beacon.create({
      data: {
        classroomId: room.id,
        label: 'R1 front (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: R1_UID,
        thresholdRssi: -75,
      },
    })
  ).id;
  await prisma.beacon.create({
    data: {
      classroomId: room2.id,
      label: 'R2 front (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: R2_UID,
      thresholdRssi: -75,
    },
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
  const newStudent = async (n: number, sectionId: string): Promise<Student> => {
    const user = await createUser(prisma, {
      email: `student${n}@example.test`,
      roles: ['STUDENT'],
      password: null,
    });
    const s = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: `99${String(n).padStart(6, '0')}`,
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
        offeringId: sectionId === section.id ? offering.id : otherOffering.id,
        sectionId,
        createdById: adminId,
        enrolledAt: new Date('2030-08-16T08:00:00Z'),
      },
    });
    const auth = await sessionFor(user.id, 'STUDENT');
    const phone = newPhone();
    return { auth, phone, deviceId: await registerPhone(auth, phone), profileId: s.id };
  };
  students = [];
  for (let n = 1; n <= 6; n++) students.push(await newStudent(n, section.id));
  otherCourseStudent = await newStudent(50, otherSection.id);
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
  attendanceId = (
    await http.post(`/api/v1/class-sessions/${classId}/attendance/open`).set(lecturer).send({}).expect(201)
  ).body.id;
});

const qr = async () =>
  (await http.get(`/api/v1/attendance-sessions/${attendanceId}/qr`).set(lecturer).expect(200)).body
    .token as string;

/** In the room: the room's beacon heard strongly, location on site. */
const inRoom = (token: string) => ({
  qrToken: token,
  bluetooth: 'ON',
  readings: [{ identifier: R1_UID, rssi: -62 }],
  location: north(30),
});
/** At home: no beacon, location far away. */
const atHome = (token: string) => ({ qrToken: token, bluetooth: 'ON', readings: [], location: north(8000) });

/** A check-in exactly as the app sends it: signed by the phone, with an idempotency key. */
function checkIn(
  who: Student,
  body: object,
  key: string = randomUUID(),
  deviceId = who.deviceId,
  phone = who.phone,
) {
  const text = JSON.stringify(body);
  const timestamp = String(clock.now().getTime());
  const nonce = randomUUID().replaceAll('-', '');
  const path = '/api/v1/check-ins';
  const payload = deviceSigningPayload({
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodySha256Hex: createHash('sha256').update(text).digest('hex'),
  });
  return http
    .post(path)
    .set(who.auth)
    .set('Content-Type', 'application/json')
    .set('Idempotency-Key', key)
    .set({
      [DEVICE_HEADERS.device]: deviceId,
      [DEVICE_HEADERS.timestamp]: timestamp,
      [DEVICE_HEADERS.nonce]: nonce,
      [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), phone.privateKey).toString('base64url'),
    })
    .send(text);
}
const recordOf = async (s: Student) =>
  (
    await prisma.attendanceRecord.findUnique({
      where: { classSessionId_studentId: { classSessionId: classId, studentId: s.profileId } },
    })
  )?.status ?? null;

describe('scenario 1: checking in from the classroom', () => {
  it('is verified and marks the student present, keeping the attempt, its evidence and the rule trace', async () => {
    at('10:01');
    const result = (await checkIn(students[0]!, inRoom(await qr())).expect(200)).body;
    expect(result).toMatchObject({
      outcome: 'VERIFIED',
      recordStatus: 'PRESENT',
      message: 'You’re checked in.',
      reason: null,
    });
    const attempt = await prisma.attendanceAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt).toMatchObject({
      outcome: 'VERIFIED',
      qrWindow: 12,
      policyVersion: 0,
      delayedUpload: false,
    });
    expect(attempt.evidence).toMatchObject({
      ble: 'STRONG',
      strongestOwnRssi: -62,
      gps: 'INSIDE',
      device: 'TRUSTED',
    });
    const decision = await prisma.verificationDecision.findFirstOrThrow({
      where: { attemptId: result.attemptId },
    });
    expect(decision.decidedBy).toBe('ENGINE');
    expect((decision.ruleTrace as string[]).join(' ')).toContain('all gates passed');
    expect(await recordOf(students[0]!)).toBe('PRESENT');
    // The phone's report reached beacon health.
    expect(await prisma.beaconSighting.count({ where: { beaconId } })).toBe(1);
    // Kept exactly as received.
    await expect(prisma.attendanceAttempt.updateMany({ data: { outcome: 'REJECTED' } })).rejects.toThrow();
    await expect(prisma.verificationDecision.deleteMany({})).rejects.toThrow();
  });

  it('is late after the late time, judged by server time', async () => {
    at('10:16');
    expect((await checkIn(students[1]!, inRoom(await qr())).expect(200)).body.recordStatus).toBe('LATE');
  });
});

describe('scenarios 2 and 4: checking in from somewhere else', () => {
  it('a shared live code used at home is rejected, may be retried, and never counts', async () => {
    at('10:02');
    const result = (await checkIn(students[0]!, atHome(await qr())).expect(200)).body;
    expect(result).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NOT_IN_CLASSROOM',
      recordStatus: 'REJECTED',
    });
  });

  it('records only move up: a failed retry after a verified check-in changes nothing', async () => {
    at('10:02');
    await checkIn(students[0]!, inRoom(await qr())).expect(200);
    const retry = (await checkIn(students[0]!, atHome(await qr())).expect(200)).body;
    expect(retry).toMatchObject({ outcome: 'REJECTED', recordStatus: 'PRESENT' });
    expect(await recordOf(students[0]!)).toBe('PRESENT');
  });

  it('another room’s beacon is "wrong room"', async () => {
    at('10:02');
    const body = { ...inRoom(await qr()), readings: [{ identifier: R2_UID, rssi: -55 }] };
    expect((await checkIn(students[0]!, body).expect(200)).body.reason).toBe('WRONG_ROOM');
  });
});

describe('scenarios 3 and 12: old codes and lost connections', () => {
  it('a screenshot used later is expired and creates no record', async () => {
    at('10:00');
    const old = await qr();
    at('10:03:00'); // three minutes later: well past the grace and the offline allowance
    const result = (await checkIn(students[0]!, inRoom(old)).expect(200)).body;
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'QR_EXPIRED', recordStatus: null });
    expect(await recordOf(students[0]!)).toBeNull();
    expect(await prisma.attendanceAttempt.count()).toBe(1); // still recorded as an attempt
  });

  it('a check-in delayed by a lost connection is accepted within the offline grace, but waits for the lecturer', async () => {
    at('10:00');
    const scanned = await qr();
    at('10:01:00'); // the code's windows have passed, but within 120 s of them
    const result = (await checkIn(students[0]!, inRoom(scanned)).expect(200)).body;
    expect(result).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'DELAYED_UPLOAD',
      recordStatus: 'PENDING',
    });
  });

  it('a forged or edited code is invalid; something that is not an attendance code is not recorded', async () => {
    at('10:00');
    const token = await qr();
    const edited = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await checkIn(students[0]!, inRoom(edited)).expect(200)).body.reason).toBe('QR_INVALID');
    const junk = (await checkIn(students[0]!, inRoom('https://example.test/not-a-code')).expect(200)).body;
    expect(junk).toMatchObject({ attemptId: null, reason: 'QR_INVALID' });
    expect(await prisma.attendanceAttempt.count()).toBe(1);
  });
});

describe('scenarios 5 and 6: people who are not in the class', () => {
  it('a student of another course is not enrolled, and gets no record', async () => {
    at('10:01');
    const result = (await checkIn(otherCourseStudent, inRoom(await qr())).expect(200)).body;
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_ENROLLED', recordStatus: null });
    expect(await prisma.attendanceRecord.count()).toBe(0);
  });

  it('someone who is not a student cannot check in at all', async () => {
    const lecturerUserId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'lecturer@example.test' } })
    ).id;
    const phone = newPhone();
    const deviceId = await registerPhone(lecturer, phone);
    at('10:01');
    const asLecturer: Student = { auth: lecturer, phone, deviceId, profileId: lecturerUserId };
    expect((await checkIn(asLecturer, inRoom(await qr())).expect(403)).body.code).toBe('NOT_A_STUDENT');
  });
});

describe('scenario 7: duplicate requests', () => {
  it('the same request twice returns the first answer and records one attempt', async () => {
    at('10:01');
    const body = inRoom(await qr());
    const key = randomUUID();
    const first = (await checkIn(students[0]!, body, key).expect(200)).body;
    const second = (await checkIn(students[0]!, body, key).expect(200)).body;
    expect(second).toEqual(first);
    expect(await prisma.attendanceAttempt.count()).toBe(1);
  });

  it('the same request five times at once records one attempt; different requests at once give one record', async () => {
    at('10:01');
    const body = inRoom(await qr());
    const key = randomUUID();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => checkIn(students[0]!, body, key)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(answers.map((r) => r.body.attemptId)).size).toBe(1);
    expect(await prisma.attendanceAttempt.count()).toBe(1);
    const different = await Promise.all([1, 2, 3].map(() => checkIn(students[1]!, body)));
    expect(different.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await prisma.attendanceRecord.count({ where: { studentId: students[1]!.profileId } })).toBe(1);
    expect(await prisma.attendanceAttempt.count({ where: { studentId: students[1]!.profileId } })).toBe(3);
  });

  it('needs an idempotency key and the phone’s signature', async () => {
    at('10:01');
    const token = await qr();
    await http
      .post('/api/v1/check-ins')
      .set(students[0]!.auth)
      .set('Idempotency-Key', randomUUID())
      .send(inRoom(token))
      .expect(401);
    const res = await checkIn(students[0]!, inRoom(token), 'not-a-uuid').expect(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('scenario 8: Bluetooth off', () => {
  it('asks the student to turn it on, and they may retry', async () => {
    at('10:01');
    const body = { ...inRoom(await qr()), bluetooth: 'OFF', readings: [] };
    expect((await checkIn(students[0]!, body).expect(200)).body).toMatchObject({
      outcome: 'REJECTED',
      reason: 'BLUETOOTH_OFF',
      retryAllowed: true,
    });
    expect((await checkIn(students[0]!, inRoom(await qr())).expect(200)).body.recordStatus).toBe('PRESENT');
  });
});

describe('scenario 9: beacon failure (degraded mode)', () => {
  it('check-ins wait for the lecturer instead of being rejected when the beacon is suspected faulty', async () => {
    at('10:01');
    const silent = { ...inRoom(await qr()), readings: [] };
    // Three phones on site hear nothing: the beacon is suspected faulty and the class is degraded.
    for (const s of students.slice(0, 3)) await checkIn(s, silent).expect(200);
    expect((await prisma.beacon.findUniqueOrThrow({ where: { id: beaconId } })).status).toBe(
      'SUSPECTED_FAULTY',
    );
    const next = (await checkIn(students[3]!, { ...silent, qrToken: await qr() }).expect(200)).body;
    expect(next).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'DEGRADED_MODE',
      recordStatus: 'PENDING',
    });
    // A retry by a student rejected before the fault was known is not held against them either.
    expect(
      (await checkIn(students[0]!, { ...silent, qrToken: await qr() }).expect(200)).body.recordStatus,
    ).toBe('PENDING');
  });
});

describe('scenario 11: changing phones, and shared phones', () => {
  it('a phone that is not yet approved waits for the lecturer', async () => {
    const replacement = newPhone();
    const deviceId = await registerPhone(students[0]!.auth, replacement);
    at('10:01');
    const result = (
      await checkIn(students[0]!, inRoom(await qr()), randomUUID(), deviceId, replacement).expect(200)
    ).body;
    expect(result).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'NEW_DEVICE',
      recordStatus: 'PENDING',
    });
  });

  it('one phone used by two students in the same class goes to review and is flagged', async () => {
    // Student 6 registers on student 1's physical phone (same installation).
    const deviceId = await registerPhone(students[5]!.auth, students[0]!.phone);
    at('10:01');
    await checkIn(students[0]!, inRoom(await qr())).expect(200);
    const second = (
      await checkIn(students[5]!, inRoom(await qr()), randomUUID(), deviceId, students[0]!.phone).expect(200)
    ).body;
    expect(second).toMatchObject({
      outcome: 'MANUAL_REVIEW_REQUIRED',
      reason: 'SHARED_DEVICE',
      recordStatus: 'UNDER_REVIEW',
    });
    const flag = await prisma.riskFlag.findFirstOrThrow({
      where: { type: 'SHARED_DEVICE', studentId: students[5]!.profileId },
    });
    expect(flag.evidence).toMatchObject({ attemptId: second.attemptId });
  });
});

describe('closed sessions and attempt limits', () => {
  it('a closed session refuses check-ins, and closing marks only students without a record ABSENT', async () => {
    at('10:01');
    await checkIn(students[0]!, inRoom(await qr())).expect(200);
    const token = await qr();
    await http.post(`/api/v1/attendance-sessions/${attendanceId}/close`).set(lecturer).send({}).expect(200);
    expect((await checkIn(students[1]!, inRoom(token)).expect(200)).body.reason).toBe('SESSION_NOT_OPEN');
    expect(await recordOf(students[0]!)).toBe('PRESENT');
    expect(await recordOf(students[1]!)).toBe('ABSENT');
    expect(await prisma.attendanceRecord.count({ where: { status: 'ABSENT' } })).toBe(5);
  });

  it('after five attempts the student is told to ask the lecturer', async () => {
    at('10:01');
    for (let i = 0; i < 5; i++) await checkIn(students[0]!, atHome(await qr())).expect(200);
    const sixth = (await checkIn(students[0]!, inRoom(await qr())).expect(200)).body;
    expect(sixth).toMatchObject({
      outcome: 'REJECTED',
      reason: 'TOO_MANY_ATTEMPTS',
      recordStatus: 'REJECTED',
    });
    expect(await prisma.attendanceAttempt.count({ where: { studentId: students[0]!.profileId } })).toBe(6);
  });

  it('a student can read back their own check-in only', async () => {
    at('10:01');
    const result = (await checkIn(students[0]!, inRoom(await qr())).expect(200)).body;
    expect(
      (await http.get(`/api/v1/check-ins/${result.attemptId}`).set(students[0]!.auth).expect(200)).body,
    ).toEqual(result);
    await http.get(`/api/v1/check-ins/${result.attemptId}`).set(students[1]!.auth).expect(404);
  });
});

describe('what is open for me', () => {
  it('a student sees attendance open for their class (and their status), others see nothing', async () => {
    at('10:01');
    const before = (await http.get('/api/v1/me/open-attendance').set(students[0]!.auth).expect(200)).body
      .data;
    expect(before).toEqual([
      expect.objectContaining({
        attendanceSessionId: attendanceId,
        myStatus: null,
        course: expect.objectContaining({ code: 'TST101' }),
      }),
    ]);
    await checkIn(students[0]!, inRoom(await qr())).expect(200);
    expect(
      (await http.get('/api/v1/me/open-attendance').set(students[0]!.auth).expect(200)).body.data[0].myStatus,
    ).toBe('PRESENT');
    expect(
      (await http.get('/api/v1/me/open-attendance').set(otherCourseStudent.auth).expect(200)).body.data,
    ).toEqual([]);
    at('10:30'); // after it closes
    expect(
      (await http.get('/api/v1/me/open-attendance').set(students[1]!.auth).expect(200)).body.data,
    ).toEqual([]);
  });
});

describe('toward scenario 25: a class checking in at once', () => {
  it('handles every student at the same moment, each exactly once', async () => {
    at('10:01');
    const token = await qr();
    const answers = await Promise.all(students.map((s) => checkIn(s, inRoom(token))));
    expect(answers.map((r) => r.status)).toEqual(students.map(() => 200));
    expect(answers.every((r) => r.body.recordStatus === 'PRESENT')).toBe(true);
    expect(await prisma.attendanceRecord.count({ where: { status: 'PRESENT' } })).toBe(students.length);
    expect(admin).toBeDefined();
  });
});
