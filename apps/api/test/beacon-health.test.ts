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
import {
  BeaconHealthService,
  type ObservationInput,
} from '../src/modules/verification/beacon-health.service.js';
import { createUser, resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Beacon health and degraded mode (Phase 4 step 5). Obviously fake data: a made-up site, one class
// on Tuesday 2030-08-20 10:00–11:30 that the lecturer has started, phones that are rows in the table.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T10:05:00Z');
const at = (hhmm: string) => clock.set(`2030-08-20T${hhmm}:00Z`);
const SITE = { lat: 5.6, lng: -0.18 };
const north = (m: number, accuracyM = 15) => ({
  latitude: SITE.lat + m / 111_195,
  longitude: SITE.lng,
  accuracyM,
});

let app: INestApplication;
let prisma: PrismaService;
let health: BeaconHealthService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let adminId: string;
let lecturerUserId: string;
let ids: {
  room: string;
  otherRoom: string;
  beacon: string;
  otherBeacon: string;
  session: string;
  lecturer: string;
  section: string;
};
let phones: string[];

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
  health = app.get(BeaconHealthService);
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  at('10:05');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
  admin = signedIn.auth;
  adminId = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
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
  const lecturerUser = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  lecturerUserId = lecturerUser.id;
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
  const otherRoom = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'R2', name: 'Room 2 (test)' },
  });
  const beacon = await prisma.beacon.create({
    data: {
      classroomId: room.id,
      label: 'R1 front (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: '0123456789abcdef0123456789abcd01',
      thresholdRssi: -75,
    },
  });
  const otherBeacon = await prisma.beacon.create({
    data: {
      classroomId: otherRoom.id,
      label: 'R2 front (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: '0123456789abcdef0123456789abcd02',
      thresholdRssi: -75,
    },
  });
  const session = await prisma.classSession.create({
    data: {
      kind: 'MAKEUP',
      lecturerId: profile.id,
      classroomId: room.id,
      scheduledStart: new Date('2030-08-20T10:00:00Z'),
      scheduledEnd: new Date('2030-08-20T11:30:00Z'),
      status: 'ACTIVE',
      actualStart: new Date('2030-08-20T10:01:00Z'),
      sections: { create: [{ sectionId: section.id }] },
    },
  });
  ids = {
    room: room.id,
    otherRoom: otherRoom.id,
    beacon: beacon.id,
    otherBeacon: otherBeacon.id,
    session: session.id,
    lecturer: profile.id,
    section: section.id,
  };
  phones = [];
  for (let n = 1; n <= 5; n++) {
    const user = await createUser(prisma, {
      email: `student${n}@example.test`,
      roles: ['STUDENT'],
      password: null,
    });
    const device = await prisma.userDevice.create({
      data: { userId: user.id, installationId: `install-${n}-test`, platform: 'ANDROID', status: 'TRUSTED' },
    });
    phones.push(device.id);
  }
});

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** One phone's report: on site by default, Bluetooth on, heard nothing. */
const observe = (phone: number, over: Partial<ObservationInput> = {}) =>
  health.recordObservation({
    deviceId: phones[phone]!,
    classroomId: ids.room,
    bluetooth: 'ON',
    location: north(20),
    heard: [],
    ...over,
  });
const beaconStatus = async (id = ids.beacon) =>
  (await prisma.beacon.findUniqueOrThrow({ where: { id } })).status;
const degradedEvents = () =>
  prisma.classEvent.count({ where: { classSessionId: ids.session, type: 'BEACON_DEGRADED' } });

describe('a beacon phones cannot hear', () => {
  it('is suspected faulty after three phones on site hear nothing during the class; the class enters degraded mode once and people are told', async () => {
    expect((await observe(0)).degraded).toBe(false);
    await observe(1, { bluetooth: 'OFF' }); // proves nothing about the beacon
    await observe(2, { location: north(3000) }); // not on site
    expect((await observe(3)).degraded).toBe(false); // two silent phones on site so far
    expect(await beaconStatus()).toBe('ACTIVE');

    at('10:08');
    const third = await observe(4);
    expect(third).toMatchObject({
      degraded: true,
      suspectedFaulty: [ids.beacon],
      classSessionId: ids.session,
    });
    expect(await beaconStatus()).toBe('SUSPECTED_FAULTY');
    expect(await beaconStatus(ids.otherBeacon)).toBe('ACTIVE'); // the room next door is untouched
    await observe(0);
    expect(await degradedEvents()).toBe(1); // recorded once

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'beacons.suspected_faulty', entityId: ids.beacon },
    });
    expect(audit.actorUserId).toBeNull(); // the system did it
    expect(audit.after).toMatchObject({ status: 'SUSPECTED_FAULTY', evidence: { silentDevices: 3 } });

    // The lecturer and the administrator responsible are told.
    await waitFor(
      async () => (await prisma.notification.count({ where: { category: 'BEACON_FAULT' } })) === 2,
      'alerts',
    );
    const toLecturer = await prisma.notification.findFirstOrThrow({
      where: { userId: lecturerUserId, category: 'BEACON_FAULT' },
    });
    expect(toLecturer.body).toContain('Their check-ins will wait for your approval');
    expect(await prisma.notification.count({ where: { userId: adminId, category: 'BEACON_FAULT' } })).toBe(1);
  });

  it('becomes active again when a phone hears it; the class stays in degraded mode, and the next class starts degraded while it is still suspected', async () => {
    for (const p of [0, 1, 2]) await observe(p);
    expect(await beaconStatus()).toBe('SUSPECTED_FAULTY');
    at('10:20');
    const heard = await observe(3, { heard: [{ beaconId: ids.beacon, rssi: -64 }] });
    expect(heard.heardAgain).toEqual([ids.beacon]);
    expect(await beaconStatus()).toBe('ACTIVE');
    expect(heard.degraded).toBe(true); // a class does not leave degraded mode part-way
    expect(
      await prisma.auditLog.count({ where: { action: 'beacons.heard_again', entityId: ids.beacon } }),
    ).toBe(1);

    // Silent again; then the next class in the room begins while the beacon is still suspected.
    at('10:40');
    for (const p of [0, 1, 2]) await observe(p);
    expect(await beaconStatus()).toBe('SUSPECTED_FAULTY');
    await prisma.classSession.update({ where: { id: ids.session }, data: { status: 'COMPLETED' } });
    const next = await prisma.classSession.create({
      data: {
        kind: 'MAKEUP',
        lecturerId: ids.lecturer,
        classroomId: ids.room,
        scheduledStart: new Date('2030-08-20T12:00:00Z'),
        scheduledEnd: new Date('2030-08-20T13:00:00Z'),
        status: 'ACTIVE',
        actualStart: new Date('2030-08-20T12:00:00Z'),
        sections: { create: [{ sectionId: ids.section }] },
      },
    });
    at('12:05');
    expect(await observe(4)).toMatchObject({ classSessionId: next.id, degraded: true });
  });

  it('is never judged outside a class, and a person’s switch-off is never undone', async () => {
    await prisma.classSession.update({ where: { id: ids.session }, data: { status: 'COMPLETED' } });
    for (const p of [0, 1, 2, 3]) expect((await observe(p)).classSessionId).toBeNull();
    expect(await beaconStatus()).toBe('ACTIVE');

    await prisma.beacon.update({ where: { id: ids.beacon }, data: { status: 'INACTIVE' } });
    await observe(0, { heard: [{ beaconId: ids.beacon, rssi: -60 }] });
    expect(await beaconStatus()).toBe('INACTIVE');
    expect(await prisma.beaconSighting.count()).toBe(0); // not on the scan list, so not recorded
  });

  it('keeps observations exactly as reported', async () => {
    await observe(0, {
      heard: [
        { beaconId: ids.beacon, rssi: -70 },
        { beaconId: ids.beacon, rssi: -61 },
      ],
    });
    expect((await prisma.beaconSighting.findFirstOrThrow()).rssi).toBe(-61); // strongest reading
    await expect(prisma.beaconObservation.updateMany({ data: { gps: 'OUTSIDE' } })).rejects.toThrow();
    await expect(prisma.beaconSighting.deleteMany({})).rejects.toThrow();
  });
});

describe('warnings for review', () => {
  it('flags a beacon heard far from its site, once per phone and beacon', async () => {
    await observe(0, { location: north(3000), heard: [{ beaconId: ids.beacon, rssi: -60 }] });
    await observe(0, { location: north(3100), heard: [{ beaconId: ids.beacon, rssi: -62 }] });
    const flags = await prisma.riskFlag.findMany({ where: { type: 'UNEXPECTED_BEACON' } });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ deviceId: phones[0], status: 'OPEN' });
    expect(flags[0]!.evidence).toMatchObject({ beaconId: ids.beacon });
    // A mocked location is never used as evidence against a beacon.
    await observe(1, {
      location: { ...north(9000), isMocked: true },
      heard: [{ beaconId: ids.otherBeacon, rssi: -60 }],
    });
    expect(await prisma.riskFlag.count({ where: { type: 'UNEXPECTED_BEACON' } })).toBe(1);
  });

  it('flags the same beacon heard in two distant places within 5 minutes', async () => {
    await observe(0, { heard: [{ beaconId: ids.beacon, rssi: -60 }] });
    at('10:07');
    await observe(1, { location: north(4000), heard: [{ beaconId: ids.beacon, rssi: -60 }] });
    const conflict = await prisma.riskFlag.findFirstOrThrow({ where: { type: 'BEACON_LOCATION_CONFLICT' } });
    expect(conflict.evidence).toMatchObject({ beaconId: ids.beacon, otherDeviceId: phones[0] });
    expect((conflict.evidence as { separationM: number }).separationM).toBeGreaterThan(3900);
    // Long enough apart in time, it is not a conflict.
    at('10:30');
    await observe(2, { heard: [{ beaconId: ids.otherBeacon, rssi: -60 }] });
    at('10:40');
    await observe(3, { location: north(4000), heard: [{ beaconId: ids.otherBeacon, rssi: -60 }] });
    expect(await prisma.riskFlag.count({ where: { type: 'BEACON_LOCATION_CONFLICT' } })).toBe(1);
  });
});

describe('health summaries', () => {
  it('summarises what phones heard every 5 minutes, and shows it to beacon managers only', async () => {
    at('10:05');
    await observe(0, { heard: [{ beaconId: ids.beacon, rssi: -60 }] });
    at('10:06');
    await observe(1, { heard: [{ beaconId: ids.beacon, rssi: -70 }] });
    await observe(1, { heard: [{ beaconId: ids.beacon, rssi: -66 }] });
    expect(await health.summariseRecent()).toBe(1);
    expect(await health.summariseRecent()).toBe(1); // safe to re-run
    const result = (await http.get(`/api/v1/beacons/${ids.beacon}/health?hours=1`).set(admin).expect(200))
      .body;
    expect(result.lastHeardAt).toBe('2030-08-20T10:06:00.000Z');
    expect(result.beacon).toMatchObject({ id: ids.beacon, status: 'ACTIVE' });
    expect(result.windows).toEqual([
      { windowStart: '2030-08-20T10:05:00.000Z', sightings: 3, distinctDevices: 2, medianRssi: -66 },
    ]);
    const student = await signInAs(app, prisma, 'student.viewer@example.test', ['STUDENT']);
    await http.get(`/api/v1/beacons/${ids.beacon}/health`).set(student.auth).expect(403);
  });
});
