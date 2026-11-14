// Load test setup (Phase 8 step 4). REHEARSAL ONLY: it creates obviously fake people and a fake class.
//
// Runs inside the production rehearsal network with the release image (compiled API code and database
// access); see load/README.md. It refuses to run unless LOAD_TEST=rehearsal-only and the storage bucket
// is the rehearsal's, so it can never put test data into a real system.
//
// Writes the fake phones' keys and short-lived tokens to /out/load-run.json for the driver (drive.mjs).
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/infrastructure/prisma/prisma.service.js';
import { SessionService } from '../dist/modules/auth/session.service.js';
import { TokenService } from '../dist/modules/auth/token.service.js';

if (process.env.LOAD_TEST !== 'rehearsal-only' || process.env.S3_BUCKET !== 'attendsure-rehearsal') {
  console.error('Refusing: the load test setup runs only in the production rehearsal (see load/README.md).');
  process.exit(1);
}

const STUDENTS = Number(process.env.LOAD_STUDENTS ?? 500);
const RUN = Number(process.env.LOAD_RUN ?? 1); // 1–9: lets the setup run again without clashing
if (!(RUN >= 1 && RUN <= 9) || !(STUDENTS >= 1 && STUDENTS <= 99_999)) {
  console.error('LOAD_RUN must be 1–9 and LOAD_STUDENTS 1–99999.');
  process.exit(1);
}
const API = process.env.LOAD_API_URL ?? 'http://api-1:3000';
const R1_UID = '0123456789abcdef0123456789abcd01';
const SITE = { lat: 5.6, lng: -0.18 };
const DAY = 86_400_000;
const now = Date.now();
const tag = `LT${RUN}`;

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
const prisma = app.get(PrismaService);
const sessions = app.get(SessionService);
const tokens = app.get(TokenService);

async function person(
  email,
  role,
  { mfaVerified = false, client = 'MOBILE', fullName = 'Load Test Person (test)' } = {},
) {
  const user = await prisma.user.create({ data: { email, fullName, status: 'ACTIVE', passwordHash: null } });
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: r.id, grantedById: user.id } });
  const { session } = await sessions.create({
    userId: user.id,
    client,
    role,
    mfaVerified,
    context: { requestId: undefined, ip: undefined, userAgent: undefined },
  });
  const { token } = await tokens.signAccess({ userId: user.id, sessionId: session.id, role });
  return { user, token };
}

if (await prisma.user.findFirst({ where: { email: { startsWith: `loadtest${RUN}.` } } })) {
  console.error(
    `Load test run ${RUN} was already set up (each student checks in once per class). Use another LOAD_RUN.`,
  );
  await app.close();
  process.exit(1);
}

const started = Date.now();
const admin = await person(`loadtest${RUN}.admin@example.test`, 'UNIVERSITY_ADMIN', {
  mfaVerified: true,
  client: 'WEB',
  fullName: 'Load Test Admin (test)',
});
const lecturer = await person(`loadtest${RUN}.lecturer@example.test`, 'LECTURER', {
  client: 'WEB',
  fullName: 'Load Test Lecturer (test)',
});

const faculty = await prisma.faculty.create({
  data: { code: `${tag}F`, name: `Load Test Faculty ${RUN} (test)` },
});
const dept = await prisma.department.create({
  data: { facultyId: faculty.id, code: `${tag}D`, name: `Load Test Department ${RUN} (test)` },
});
const programme = await prisma.programme.create({
  data: { departmentId: dept.id, code: `${tag}P`, name: `Load Test Programme ${RUN} (test)` },
});
const level = await prisma.academicLevel.create({
  data: { code: `${tag}L`, name: `Load Test Level ${RUN} (test)`, sortOrder: 90 + RUN },
});
// Academic years may not overlap, so every run shares one made-up load-test year and semester around today.
const year =
  (await prisma.academicYear.findFirst({ where: { label: { startsWith: 'LOADTEST' } } })) ??
  (await prisma.academicYear.create({
    data: { label: 'LOADTEST', startDate: new Date(now - 60 * DAY), endDate: new Date(now + 300 * DAY) },
  }));
const semester =
  (await prisma.semester.findFirst({ where: { academicYearId: year.id } })) ??
  (await prisma.semester.create({
    data: {
      academicYearId: year.id,
      number: 1,
      name: 'Load test (test)',
      startDate: new Date(now - 30 * DAY),
      endDate: new Date(now + 90 * DAY),
    },
  }));
const course = await prisma.course.create({
  data: { code: `${tag}101`, title: `Load Test Course ${RUN} (test)`, departmentId: dept.id },
});
const offering = await prisma.courseOffering.create({
  data: { courseId: course.id, semesterId: semester.id, status: 'OPEN' },
});
const section = await prisma.courseSection.create({ data: { offeringId: offering.id, code: 'A' } });
const lecturerProfile = await prisma.lecturerProfile.create({
  data: { userId: lecturer.user.id, staffNumber: `${tag}-L1`, departmentId: dept.id },
});
await prisma.lecturerAssignment.create({
  data: { lecturerId: lecturerProfile.id, sectionId: section.id, assignedById: admin.user.id },
});
const campus = await prisma.campus.create({
  data: {
    code: `${tag}C`,
    name: `Load Test Campus ${RUN} (test)`,
    geofenceLat: SITE.lat,
    geofenceLng: SITE.lng,
    geofenceRadiusM: 200,
  },
});
const building = await prisma.building.create({
  data: { campusId: campus.id, code: `${tag}B`, name: `Load Test Building ${RUN} (test)` },
});
const room = await prisma.classroom.create({
  data: { buildingId: building.id, code: `${tag}R1`, name: `Load Test Room ${RUN} (test)` },
});
await prisma.beacon.create({
  data: {
    classroomId: room.id,
    label: `Load test beacon ${RUN} (test)`,
    protocol: 'EDDYSTONE_UID',
    identifier: `${R1_UID.slice(0, 30)}${String(RUN).padStart(2, '0')}`,
    thresholdRssi: -75,
  },
});
// A class that started two minutes ago and runs for 90 minutes, so the lecturer can open attendance now.
const classSession = await prisma.classSession.create({
  data: {
    kind: 'MAKEUP',
    lecturerId: lecturerProfile.id,
    classroomId: room.id,
    scheduledStart: new Date(now - 2 * 60_000),
    scheduledEnd: new Date(now + 88 * 60_000),
    sections: { create: [{ sectionId: section.id }] },
  },
});

// Students: made-up numbers 99RNNNNN (R = run), each with a phone that has its own signing key.
const students = [];
async function addStudent(n) {
  const number = `99${RUN}${String(n).padStart(5, '0')}`;
  const p = await person(`loadtest${RUN}.student${n}@example.test`, 'STUDENT', {
    fullName: `Load Test Student ${number} (test)`,
  });
  const profile = await prisma.studentProfile.create({
    data: {
      userId: p.user.id,
      studentNumber: number,
      programmeId: programme.id,
      levelId: level.id,
      currentAcademicYearId: year.id,
      currentSemesterId: semester.id,
      registeredById: admin.user.id,
    },
  });
  await prisma.courseEnrollment.create({
    data: {
      studentId: profile.id,
      offeringId: offering.id,
      sectionId: section.id,
      createdById: admin.user.id,
      enrolledAt: new Date(now - 7 * DAY),
    },
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const installationId = crypto.randomUUID();
  // The phone registers itself through the API, as the app does after signing in.
  const res = await fetch(`${API}/api/v1/me/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationId,
      platform: 'ANDROID',
      publicKey: publicKey.export({ format: 'jwk' }).x,
    }),
  });
  if (!res.ok) throw new Error(`phone registration failed for ${number}: ${res.status} ${await res.text()}`);
  const device = await res.json();
  if (device.status !== 'TRUSTED') throw new Error(`phone for ${number} is ${device.status}, not TRUSTED`);
  students.push({
    number,
    token: p.token,
    deviceId: device.id,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  });
}
for (let i = 1; i <= STUDENTS; i += 25) {
  await Promise.all(Array.from({ length: Math.min(25, STUDENTS - i + 1) }, (_, k) => addStudent(i + k)));
}

writeFileSync(
  '/out/load-run.json',
  JSON.stringify({
    run: RUN,
    createdAt: new Date().toISOString(),
    classSessionId: classSession.id,
    sectionId: section.id,
    semesterId: semester.id,
    beaconIdentifier: `${R1_UID.slice(0, 30)}${String(RUN).padStart(2, '0')}`,
    site: SITE,
    lecturerToken: lecturer.token,
    adminToken: admin.token,
    students,
  }),
);
console.warn(
  `Load test ${RUN}: ${students.length} fake students with phones set up in ${Math.round((Date.now() - started) / 1000)} s.`,
);
await app.close();
