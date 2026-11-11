import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// The beacon register and calibration surveys (PRESENCE_VERIFICATION.md §3). Obviously fake data.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let rooms: { a: string; b: string; closed: string };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
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
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  admin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
  const campus = await prisma.campus.create({ data: { code: 'TC', name: 'Test Campus' } });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const room = (code: string, isActive = true) =>
    prisma.classroom.create({
      data: { buildingId: building.id, code, name: `Room ${code} (test)`, isActive },
    });
  rooms = { a: (await room('A')).id, b: (await room('B')).id, closed: (await room('X', false)).id };
});

const UID = '0123456789abcdef0123456789abcdef';
const create = (body: object, auth = admin) => http.post('/api/v1/beacons').set(auth).send(body);
const uidBeacon = (classroomId = rooms.a, identifier = UID) =>
  create({ classroomId, label: 'Front wall (test)', protocol: 'EDDYSTONE_UID', identifier });
const PHONES = ['Phone A (test)', 'Phone B (test)', 'Phone C (test)'];
/** The same readings from three phones. */
const readings = (beaconId: string, values: [string, number][]) =>
  PHONES.flatMap((phoneModel) =>
    values.map(([position, rssi]) => ({ beaconId, phoneModel, platform: 'ANDROID', position, rssi })),
  );
const survey = (classroomId: string, measurements: object[]) =>
  http.post('/api/v1/calibration-surveys').set(admin).send({ classroomId, measurements });

describe('registering beacons', () => {
  it('registers fixed and rotating beacons, checking identifiers by protocol', async () => {
    const uid = (await uidBeacon().expect(201)).body;
    expect(uid).toMatchObject({
      protocol: 'EDDYSTONE_UID',
      identifier: UID,
      hasRotationKey: false,
      thresholdRssi: null,
      status: 'ACTIVE',
    });
    expect(uid.classroom).toMatchObject({ code: 'A' });
    await create({
      classroomId: rooms.a,
      label: 'Bad (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: 'xyz',
    }).expect(400);
    await create({
      classroomId: rooms.a,
      label: 'iB (test)',
      protocol: 'IBEACON',
      identifier: 'f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:2',
    }).expect(201);
    // Identifiers are stored lower-case, so the same beacon cannot be registered twice by changing case.
    expect((await uidBeacon(rooms.b, UID.toUpperCase()).expect(409)).body.code).toBe('DUPLICATE_BEACON');
  });

  it('stores a rotating key encrypted and never returns it', async () => {
    const key = '00112233445566778899aabbccddeeff';
    await create({
      classroomId: rooms.a,
      label: 'EID (test)',
      protocol: 'EDDYSTONE_EID',
      identifier: 'sn-0001',
    }).expect(400);
    await create({
      classroomId: rooms.a,
      label: 'EID (test)',
      protocol: 'EDDYSTONE_EID',
      identifier: 'sn-0001',
      rotationKey: key,
    }).expect(400); // exponent
    const eid = (
      await create({
        classroomId: rooms.a,
        label: 'EID (test)',
        protocol: 'EDDYSTONE_EID',
        identifier: 'SN-0001',
        rotationKey: key,
        rotationExponent: 10,
      }).expect(201)
    ).body;
    expect(eid).toMatchObject({ identifier: 'sn-0001', hasRotationKey: true, rotationExponent: 10 });
    expect(JSON.stringify(eid)).not.toContain(key);
    const stored = await prisma.beacon.findUniqueOrThrow({ where: { id: eid.id } });
    expect(stored.rotationKeyEnc).toBeTruthy();
    expect(stored.rotationKeyEnc).not.toContain(key);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'beacons.created', entityId: eid.id },
    });
    expect(JSON.stringify(audit.after)).not.toContain(key);
    // A fixed beacon cannot carry a key.
    await create({
      classroomId: rooms.a,
      label: 'UID (test)',
      protocol: 'EDDYSTONE_UID',
      identifier: UID,
      rotationKey: key,
    }).expect(400);
  });

  it('needs a room in use, and the right permission', async () => {
    await uidBeacon(rooms.closed).expect(400);
    const lecturer = (await signInAs(app, prisma, 'lecturer@example.test', ['LECTURER'])).auth;
    await uidBeacon(rooms.a).expect(201);
    // Lecturers can see beacons (health) but not register them; Registrars see nothing.
    expect((await http.get('/api/v1/beacons').set(lecturer).expect(200)).body.data).toHaveLength(1);
    await create(
      {
        classroomId: rooms.a,
        label: 'L (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: UID.replace('0', '9'),
      },
      lecturer,
    ).expect(403);
    const registrar = (await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR'])).auth;
    await http.get('/api/v1/beacons').set(registrar).expect(403);
  });

  it('needs a reason to move or switch off a beacon, and moving clears its threshold', async () => {
    const beacon = (await uidBeacon().expect(201)).body;
    await prisma.beacon.update({ where: { id: beacon.id }, data: { thresholdRssi: -75 } });
    const patch = (body: object, version: number) =>
      http.patch(`/api/v1/beacons/${beacon.id}`).set(admin).set('If-Match', String(version)).send(body);
    await http
      .patch(`/api/v1/beacons/${beacon.id}`)
      .set(admin)
      .send({ label: 'No version (test)' })
      .expect(400);
    expect((await patch({ classroomId: rooms.b }, 0).expect(400)).body.code).toBe('REASON_REQUIRED');
    const moved = (await patch({ classroomId: rooms.b, reason: 'Room A renovated (test)' }, 0).expect(200))
      .body;
    expect(moved).toMatchObject({ classroom: { code: 'B' }, thresholdRssi: null, version: 1 });
    expect((await patch({ label: 'Stale (test)' }, 0).expect(409)).body.code).toBe('VERSION_CONFLICT');
    await patch({ status: 'INACTIVE' }, 1).expect(400);
    expect(
      (await patch({ status: 'INACTIVE', reason: 'Battery dead (test)' }, 1).expect(200)).body.status,
    ).toBe('INACTIVE');
  });
});

describe('calibration surveys', () => {
  it('computes a threshold from three phones, and applying it sets the beacon’s threshold once', async () => {
    const beacon = (await uidBeacon().expect(201)).body;
    const created = (
      await survey(
        rooms.a,
        readings(beacon.id, [
          ['INSIDE_FRONT', -58],
          ['INSIDE_BACK_ROW', -72],
          ['DOORWAY', -80],
          ['CORRIDOR', -88],
        ]),
      ).expect(201)
    ).body;
    expect(created.result).toEqual([
      expect.objectContaining({
        beaconId: beacon.id,
        phoneModels: 3,
        weakestInside: -72,
        strongestOutside: -80,
        thresholdRssi: -76,
        problem: null,
      }),
    ]);
    expect(created.appliedAt).toBeNull();
    // Nothing changes until it is applied.
    expect(
      (await http.get(`/api/v1/beacons/${beacon.id}`).set(admin).expect(200)).body.thresholdRssi,
    ).toBeNull();

    await http
      .post(`/api/v1/calibration-surveys/${created.id}/apply`)
      .set(admin)
      .send({ reason: 'First survey (test)' })
      .expect(200);
    const after = (await http.get(`/api/v1/beacons/${beacon.id}`).set(admin).expect(200)).body;
    expect(after.thresholdRssi).toBe(-76);
    expect(after.calibratedAt).toBeTruthy();
    expect(
      (await http.post(`/api/v1/calibration-surveys/${created.id}/apply`).set(admin).send({}).expect(409))
        .body.code,
    ).toBe('ALREADY_APPLIED');
    const detail = (await http.get(`/api/v1/calibration-surveys/${created.id}`).set(admin).expect(200)).body;
    expect(detail.measurements).toHaveLength(12);
  });

  it('refuses to apply a survey where a beacon could not be calibrated', async () => {
    const beacon = (await uidBeacon().expect(201)).body;
    const overlap = (
      await survey(
        rooms.a,
        readings(beacon.id, [
          ['INSIDE_BACK_ROW', -82],
          ['CORRIDOR', -78],
        ]),
      ).expect(201)
    ).body;
    expect(overlap.result[0]).toMatchObject({ thresholdRssi: null, problem: 'OVERLAP' });
    const refused = await http
      .post(`/api/v1/calibration-surveys/${overlap.id}/apply`)
      .set(admin)
      .send({})
      .expect(409);
    expect(refused.body.code).toBe('SURVEY_HAS_PROBLEMS');
    expect(refused.body.errors.beacons).toEqual([{ beaconId: beacon.id, problem: 'OVERLAP' }]);
  });

  it('accepts readings only of the surveyed room’s beacons, and keeps them exactly as recorded', async () => {
    const inA = (await uidBeacon().expect(201)).body;
    const inB = (await uidBeacon(rooms.b, UID.replace('0', '1')).expect(201)).body;
    const wrong = await survey(rooms.a, readings(inB.id, [['INSIDE_FRONT', -60]])).expect(400);
    expect(wrong.body.code).toBe('BEACON_NOT_IN_ROOM');
    await survey(
      rooms.a,
      readings(inA.id, [
        ['INSIDE_FRONT', -60],
        ['CORRIDOR', -90],
      ]),
    ).expect(201);
    await expect(prisma.calibrationMeasurement.updateMany({ data: { rssi: -10 } })).rejects.toThrow();
    await expect(prisma.calibrationMeasurement.deleteMany({})).rejects.toThrow();
    await survey(rooms.a, [
      { beaconId: inA.id, phoneModel: 'X (test)', platform: 'ANDROID', position: 'INSIDE_FRONT', rssi: 5 },
    ]).expect(400);
  });

  it('builds one survey from several phones, each adding its own readings until it is applied', async () => {
    const beacon = (await uidBeacon().expect(201)).body;
    const other = (await uidBeacon(rooms.b, UID.replace('0', '1')).expect(201)).body;
    const phone = (phoneModel: string, values: [string, number][]) =>
      values.map(([position, rssi]) => ({
        beaconId: beacon.id,
        phoneModel,
        platform: 'ANDROID',
        position,
        rssi,
      }));
    const values: [string, number][] = [
      ['INSIDE_BACK_ROW', -70],
      ['CORRIDOR', -86],
    ];
    const created = (await survey(rooms.a, phone(PHONES[0]!, values)).expect(201)).body;
    expect(created.result[0]).toMatchObject({ phoneModels: 1, problem: 'NOT_ENOUGH_PHONES' });
    const add = (body: object) =>
      http.post(`/api/v1/calibration-surveys/${created.id}/measurements`).set(admin).send(body);

    await add({ measurements: phone(PHONES[1]!, values) }).expect(200);
    const third = (await add({ measurements: phone(PHONES[2]!, values) }).expect(200)).body;
    expect(third.result[0]).toMatchObject({ phoneModels: 3, thresholdRssi: -78, problem: null });
    expect(third.measurements).toHaveLength(6);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'calibration_surveys.measurements_added', entityId: created.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.after).toMatchObject({ readingsAdded: 2 });

    // Only this room's beacons, and only while the survey is open.
    const wrongRoom = await add({
      measurements: [{ ...phone('Phone D (test)', values)[0], beaconId: other.id }],
    }).expect(400);
    expect(wrongRoom.body.code).toBe('BEACON_NOT_IN_ROOM');
    await http.post(`/api/v1/calibration-surveys/${created.id}/apply`).set(admin).send({}).expect(200);
    expect((await add({ measurements: phone('Phone D (test)', values) }).expect(409)).body.code).toBe(
      'ALREADY_APPLIED',
    );
    expect((await prisma.beacon.findUniqueOrThrow({ where: { id: beacon.id } })).thresholdRssi).toBe(-78);
  });

  it('refuses to apply a survey after its beacon moved to another room', async () => {
    const beacon = (await uidBeacon().expect(201)).body;
    const created = (
      await survey(
        rooms.a,
        readings(beacon.id, [
          ['INSIDE_FRONT', -60],
          ['CORRIDOR', -90],
        ]),
      ).expect(201)
    ).body;
    await http
      .patch(`/api/v1/beacons/${beacon.id}`)
      .set(admin)
      .set('If-Match', '0')
      .send({ classroomId: rooms.b, reason: 'Moved (test)' })
      .expect(200);
    expect(
      (await http.post(`/api/v1/calibration-surveys/${created.id}/apply`).set(admin).send({}).expect(409))
        .body.code,
    ).toBe('BEACON_MOVED');
    expect((await prisma.beacon.findUniqueOrThrow({ where: { id: beacon.id } })).thresholdRssi).toBeNull();
    expect(
      (await prisma.calibrationSurvey.findUniqueOrThrow({ where: { id: created.id } })).appliedAt,
    ).toBeNull();
  });
});
