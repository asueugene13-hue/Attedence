import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import type request from 'supertest';
import type { FakeClock } from '../src/infrastructure/clock/clock.js';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { createUser, signInAs } from './fixtures.js';

/**
 * A class ready for attendance, for the Phase 5 tests. Obviously fake data: a made-up site, a class
 * on Tuesday 2030-08-20 10:00–11:30 (Africa/Accra = UTC) in room R1 with a calibrated beacon, room R2
 * next door with its own, students with signed and trusted phones, and a student of another course.
 */
export const SITE = { lat: 5.6, lng: -0.18 };
export const R1_UID = '0123456789abcdef0123456789abcd01';
export const R2_UID = '0123456789abcdef0123456789abcd02';
export const north = (m: number, accuracyM = 15) => ({
  latitude: SITE.lat + m / 111_195,
  longitude: SITE.lng,
  accuracyM,
});

export interface Phone {
  installationId: string;
  privateKey: KeyObject;
  publicKey: string;
}
export interface Person {
  auth: Record<string, string>;
  token: string;
  userId: string;
}
export interface Student extends Person {
  phone: Phone;
  deviceId: string;
  profileId: string;
}

export function newPhone(installationId: string = randomUUID()): Phone {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { installationId, privateKey, publicKey: publicKey.export({ format: 'jwk' }).x as string };
}

export async function sessionFor(
  app: INestApplication,
  userId: string,
  role: 'LECTURER' | 'STUDENT',
): Promise<Person> {
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
  return { auth: { Authorization: `Bearer ${token}` }, token, userId };
}

export async function registerPhone(
  http: ReturnType<typeof request>,
  auth: Record<string, string>,
  phone: Phone,
) {
  return (
    await http
      .post('/api/v1/me/devices')
      .set(auth)
      .send({ installationId: phone.installationId, platform: 'ANDROID', publicKey: phone.publicKey })
      .expect(200)
  ).body.id as string;
}

export async function buildClass(
  app: INestApplication,
  prisma: PrismaService,
  http: ReturnType<typeof request>,
  options: { students?: number } = {},
) {
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
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
  const otherLecturerUser = await createUser(prisma, {
    email: 'other.lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  const lecturerProfile = await prisma.lecturerProfile.create({
    data: { userId: lecturerUser.id, staffNumber: 'TL1', departmentId: dept.id },
  });
  await prisma.lecturerProfile.create({
    data: { userId: otherLecturerUser.id, staffNumber: 'TL2', departmentId: dept.id },
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
  const beacon = await prisma.beacon.create({
    data: {
      classroomId: room.id,
      label: 'R1 front (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: R1_UID,
      thresholdRssi: -75,
    },
  });
  await prisma.beacon.create({
    data: {
      classroomId: room2.id,
      label: 'R2 front (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: R2_UID,
      thresholdRssi: -75,
    },
  });
  const classId = (
    await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: lecturerProfile.id,
        classroomId: room.id,
        scheduledStart: new Date('2030-08-20T10:00:00Z'),
        scheduledEnd: new Date('2030-08-20T11:30:00Z'),
        sections: { create: [{ sectionId: section.id }] },
      },
    })
  ).id;

  /** A student with a trusted phone; `enrolledAt` decides eligibility. */
  const addStudent = async (
    n: number,
    opts: { sectionId?: string; enrolledAt?: string } = {},
  ): Promise<Student> => {
    const sectionId = opts.sectionId ?? section.id;
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
        enrolledAt: new Date(opts.enrolledAt ?? '2030-08-16T08:00:00Z'),
      },
    });
    const person = await sessionFor(app, user.id, 'STUDENT');
    const phone = newPhone();
    return { ...person, phone, deviceId: await registerPhone(http, person.auth, phone), profileId: s.id };
  };

  const students: Student[] = [];
  for (let n = 1; n <= (options.students ?? 4); n++) students.push(await addStudent(n));
  return {
    admin: {
      auth: signedIn.auth,
      token: signedIn.auth.Authorization!.slice('Bearer '.length),
      userId: adminId,
    } as Person,
    lecturer: await sessionFor(app, lecturerUser.id, 'LECTURER'),
    otherLecturer: await sessionFor(app, otherLecturerUser.id, 'LECTURER'),
    classId,
    beaconId: beacon.id,
    sectionId: section.id,
    otherSectionId: otherSection.id,
    students,
    addStudent,
  };
}

/** A check-in exactly as the app sends it: signed by the phone, with an idempotency key. */
export function signedCheckIn(
  http: ReturnType<typeof request>,
  clock: FakeClock,
  who: Student,
  body: object,
  key: string = randomUUID(),
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
      [DEVICE_HEADERS.device]: who.deviceId,
      [DEVICE_HEADERS.timestamp]: timestamp,
      [DEVICE_HEADERS.nonce]: nonce,
      [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), who.phone.privateKey).toString(
        'base64url',
      ),
    })
    .send(text);
}

/** In the room: the room's beacon heard strongly, location on site. */
export const inRoom = (token: string) => ({
  qrToken: token,
  bluetooth: 'ON',
  readings: [{ identifier: R1_UID, rssi: -62 }],
  location: north(30),
});
/** No beacon heard, location on site (what phones report when the beacon has failed). */
export const silent = (token: string) => ({ ...inRoom(token), readings: [] });
