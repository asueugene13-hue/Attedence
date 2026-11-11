import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
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
import { createUser, resetDatabase, resetRedis } from './fixtures.js';

// "Check this classroom" (Phase 4 step 4): a phone's real evidence through the real rules, signed by
// the phone, recording nothing. Obviously fake data: a campus geofence at a made-up point.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-19T08:00:00Z');
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let student: Record<string, string>;
let rooms: { a: string; b: string };
const CENTRE = { latitude: 5.6, longitude: -0.18 };
const ROOM_A_UID = '0123456789abcdef0123456789abcd01';
const ROOM_B_UID = '0123456789abcdef0123456789abcd02';
const UNCALIBRATED_UID = '0123456789abcdef0123456789abcd03';

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

async function sessionFor(userId: string) {
  const { SessionService } = await import('../src/modules/auth/session.service.js');
  const { TokenService } = await import('../src/modules/auth/token.service.js');
  const { session } = await app.get(SessionService).create({
    userId,
    client: 'MOBILE',
    role: 'LECTURER',
    mfaVerified: false,
    context: { requestId: undefined, ip: undefined, userAgent: undefined },
  });
  const { token } = await app
    .get(TokenService)
    .signAccess({ userId, sessionId: session.id, role: 'LECTURER' });
  return { Authorization: `Bearer ${token}` };
}

function newPhone() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    installationId: randomUUID(),
    privateKey,
    publicKey: publicKey.export({ format: 'jwk' }).x as string,
  };
}
type Phone = ReturnType<typeof newPhone>;
let phone: Phone;
let deviceId: string;

/** A signed classroom check, exactly as the app sends it. */
function check(body: object, as: { phone: Phone; deviceId: string } = { phone, deviceId }) {
  const text = JSON.stringify(body);
  const timestamp = String(clock.now().getTime());
  const nonce = randomUUID().replaceAll('-', '');
  const path = '/api/v1/classroom-checks';
  const payload = deviceSigningPayload({
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodySha256Hex: createHash('sha256').update(text).digest('hex'),
  });
  return http
    .post(path)
    .set(student)
    .set('Content-Type', 'application/json')
    .set({
      [DEVICE_HEADERS.device]: as.deviceId,
      [DEVICE_HEADERS.timestamp]: timestamp,
      [DEVICE_HEADERS.nonce]: nonce,
      [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), as.phone.privateKey).toString('base64url'),
    })
    .send(text);
}
/** Metres north of the campus centre. */
const north = (metres: number, accuracyM = 15) => ({
  latitude: CENTRE.latitude + metres / 111_195,
  longitude: CENTRE.longitude,
  accuracyM,
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const campus = await prisma.campus.create({
    data: {
      code: 'TC',
      name: 'Test Campus',
      geofenceLat: CENTRE.latitude,
      geofenceLng: CENTRE.longitude,
      geofenceRadiusM: 200,
    },
  });
  const building = await prisma.building.create({
    data: { campusId: campus.id, code: 'TB', name: 'Test Building' },
  });
  const roomA = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'A', name: 'Room A (test)' },
  });
  const roomB = await prisma.classroom.create({
    data: { buildingId: building.id, code: 'B', name: 'Room B (test)' },
  });
  rooms = { a: roomA.id, b: roomB.id };
  await prisma.beacon.createMany({
    data: [
      {
        classroomId: roomA.id,
        label: 'A front (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: ROOM_A_UID,
        thresholdRssi: -75,
      },
      {
        classroomId: roomB.id,
        label: 'B front (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: ROOM_B_UID,
        thresholdRssi: -75,
      },
      {
        classroomId: roomA.id,
        label: 'A back, not calibrated (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: UNCALIBRATED_UID,
      },
    ],
  });
  const user = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  student = await sessionFor(user.id);
  phone = newPhone();
  deviceId = (
    await http
      .post('/api/v1/me/devices')
      .set(student)
      .send({ installationId: phone.installationId, platform: 'ANDROID', publicKey: phone.publicKey })
      .expect(200)
  ).body.id;
});

const body = (
  readings: { identifier: string; rssi: number }[],
  location: object | null = north(50),
  bluetooth = 'ON',
) => ({
  classroomId: rooms.a,
  bluetooth,
  readings,
  location,
});

describe('checking a classroom from a phone', () => {
  it('verifies a strong beacon of this room with GPS on site, and records nothing', async () => {
    const auditBefore = await prisma.auditLog.count();
    const result = (await check(body([{ identifier: ROOM_A_UID.toUpperCase(), rssi: -60 }])).expect(200))
      .body;
    expect(result.evidence).toMatchObject({
      ble: 'STRONG',
      strongestOwnRssi: -60,
      gps: 'INSIDE',
      hasGeofence: true,
      device: 'TRUSTED',
    });
    expect(result.decision).toMatchObject({ outcome: 'VERIFIED', message: 'You’re checked in.' });
    expect(result.policyVersion).toBe(0);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
  });

  it('says “another room” when only the next room’s beacon is heard strongly', async () => {
    const result = (await check(body([{ identifier: ROOM_B_UID, rssi: -55 }])).expect(200)).body;
    expect(result.evidence.ble).toBe('OTHER_ROOM');
    expect(result.decision).toMatchObject({ outcome: 'REJECTED', reason: 'WRONG_ROOM', retryAllowed: true });
  });

  it('rejects when nothing is heard and the phone is clearly off campus', async () => {
    const result = (await check(body([], north(2000))).expect(200)).body;
    expect(result.evidence).toMatchObject({ ble: 'NONE', gps: 'OUTSIDE' });
    expect(result.evidence.distanceM).toBeGreaterThan(1900);
    expect(result.decision.outcome).toBe('REJECTED');
  });

  it('ignores beacons that are not registered, and never treats an uncalibrated one as strong', async () => {
    const unknown = (
      await check(body([{ identifier: 'ffffffffffffffffffffffffffffffff', rssi: -40 }])).expect(200)
    ).body;
    expect(unknown.evidence).toMatchObject({ ble: 'NONE', recognisedReadings: 0 });
    const uncalibrated = (await check(body([{ identifier: UNCALIBRATED_UID, rssi: -40 }])).expect(200)).body;
    expect(uncalibrated.evidence.ble).toBe('WEAK');
    expect(uncalibrated.decision.outcome).toBe('PENDING_VERIFICATION');
  });

  it('asks for Bluetooth when it is off, and treats a missing location as uncertain', async () => {
    expect((await check(body([], north(10), 'OFF')).expect(200)).body.decision.reason).toBe('BLUETOOTH_OFF');
    const noLocation = (await check(body([{ identifier: ROOM_A_UID, rssi: -60 }], null)).expect(200)).body;
    expect(noLocation.evidence.gps).toBe('UNCERTAIN');
    expect(noLocation.decision.outcome).toBe('VERIFIED'); // GPS is never held against the student
  });

  it('holds evidence from a phone that is not the student’s approved phone yet', async () => {
    // Only students' later phones wait for approval; simulate one.
    await prisma.userDevice.update({ where: { id: deviceId }, data: { status: 'PENDING_APPROVAL' } });
    const result = (await check(body([{ identifier: ROOM_A_UID, rssi: -60 }])).expect(200)).body;
    expect(result.evidence.device).toBe('PENDING_APPROVAL');
    expect(result.decision).toMatchObject({ outcome: 'PENDING_VERIFICATION', reason: 'NEW_DEVICE' });
  });

  it('must be signed by the phone', async () => {
    await http.post('/api/v1/classroom-checks').set(student).send(body([])).expect(401);
    const stranger = newPhone();
    await check(body([]), { phone: stranger, deviceId }).expect(401);
  });

  it('gives phones the identifiers to listen for, without thresholds or rotating beacons', async () => {
    await prisma.beacon.create({
      data: {
        classroomId: rooms.a,
        label: 'Off (test)',
        protocol: 'EDDYSTONE_UID',
        identifier: '0123456789abcdef0123456789abcd09',
        status: 'INACTIVE',
      },
    });
    const list = (await http.get('/api/v1/me/beacon-scan-list').set(student).expect(200)).body.data;
    expect(list.map((b: { identifier: string }) => b.identifier).sort()).toEqual(
      [ROOM_A_UID, ROOM_B_UID, UNCALIBRATED_UID].sort(),
    );
    expect(Object.keys(list[0]).sort()).toEqual(['classroomId', 'id', 'identifier', 'protocol']);
    const response = (await http.get('/api/v1/me/beacon-scan-list').set(student).expect(200)).body;
    expect(response.rooms).toEqual([
      { id: rooms.a, code: 'A', name: 'Room A (test)' },
      { id: rooms.b, code: 'B', name: 'Room B (test)' },
    ]);
    // A room taken out of use drops out, with its beacons.
    await prisma.classroom.update({ where: { id: rooms.b }, data: { isActive: false } });
    const after = (await http.get('/api/v1/me/beacon-scan-list').set(student).expect(200)).body;
    expect(after.rooms.map((r: { code: string }) => r.code)).toEqual(['A']);
    expect(after.data.map((b: { identifier: string }) => b.identifier)).not.toContain(ROOM_B_UID);
  });
});
