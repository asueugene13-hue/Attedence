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

// Trusted phones (D-10) and signed requests. Obviously fake data. Each test phone makes its own
// Ed25519 key pair, exactly as the app does, and signs requests with it.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-19T08:00:00Z');
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;
let studentOne: { auth: Record<string, string>; userId: string; studentId: string };
let studentTwo: { auth: Record<string, string>; userId: string; studentId: string };
let lecturer: Record<string, string>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  // rawBody, as in main.ts: signatures are checked against the exact bytes sent.
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

/** A phone: an installation ID and a key pair, as the app keeps in secure storage. */
function newPhone() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    installationId: randomUUID(),
    privateKey,
    publicKey: publicKey.export({ format: 'jwk' }).x as string,
  };
}
type Phone = ReturnType<typeof newPhone>;

/** The headers a phone sends with a signed request (the same text the app signs). */
function signed(
  deviceId: string,
  key: KeyObject,
  method: string,
  path: string,
  body = '',
  options: { timestamp?: number; nonce?: string } = {},
) {
  const timestamp = String(options.timestamp ?? clock.now().getTime());
  const nonce = options.nonce ?? randomUUID().replaceAll('-', '');
  const payload = deviceSigningPayload({
    method,
    path,
    timestamp,
    nonce,
    bodySha256Hex: createHash('sha256').update(body).digest('hex'),
  });
  return {
    [DEVICE_HEADERS.device]: deviceId,
    [DEVICE_HEADERS.timestamp]: timestamp,
    [DEVICE_HEADERS.nonce]: nonce,
    [DEVICE_HEADERS.signature]: sign(null, Buffer.from(payload), key).toString('base64url'),
  };
}

const register = (auth: Record<string, string>, phone: Phone, extra: object = {}) =>
  http
    .post('/api/v1/me/devices')
    .set(auth)
    .send({
      installationId: phone.installationId,
      platform: 'ANDROID',
      model: 'Test Phone',
      publicKey: phone.publicKey,
      ...extra,
    });

const current = (auth: Record<string, string>, deviceId: string, phone: Phone, options = {}) =>
  http
    .get('/api/v1/me/devices/current')
    .set(auth)
    .set(signed(deviceId, phone.privateKey, 'GET', '/api/v1/me/devices/current', '', options));

beforeEach(async () => {
  clock.set('2030-08-19T08:00:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN']);
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
  const newStudent = async (n: number) => {
    const user = await createUser(prisma, {
      email: `student${n}@example.test`,
      roles: ['STUDENT'],
      password: null,
    });
    const profile = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        studentNumber: `9900000${n}`,
        programmeId: programme.id,
        levelId: level.id,
        currentAcademicYearId: year.id,
        currentSemesterId: semester.id,
        registeredById: adminId,
      },
    });
    return { auth: await sessionFor(user.id, 'STUDENT'), userId: user.id, studentId: profile.id };
  };
  studentOne = await newStudent(1);
  studentTwo = await newStudent(2);
  const lecturerUser = await createUser(prisma, {
    email: 'lecturer@example.test',
    roles: ['LECTURER'],
    password: null,
  });
  lecturer = await sessionFor(lecturerUser.id, 'LECTURER');
});

describe('registering phones (D-10)', () => {
  it('trusts a student’s first phone as the attendance phone; a second phone waits for approval', async () => {
    const first = newPhone();
    const one = (await register(studentOne.auth, first).expect(200)).body;
    expect(one).toMatchObject({ status: 'TRUSTED', isAttendanceDevice: true });

    const second = newPhone();
    const two = (await register(studentOne.auth, second).expect(200)).body;
    expect(two).toMatchObject({ status: 'PENDING_APPROVAL', isAttendanceDevice: false });

    // The student asks to switch; an approver sees the request and approves it.
    await http.post(`/api/v1/me/devices/${two.id}/request-trust`).set(studentOne.auth).send({}).expect(400);
    await http
      .post(`/api/v1/me/devices/${two.id}/request-trust`)
      .set(studentOne.auth)
      .send({ reason: 'My old phone broke (test)' })
      .expect(200);
    const queue = (await http.get('/api/v1/devices?requested=true').set(admin).expect(200)).body.data;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: two.id, trustRequestReason: 'My old phone broke (test)' });
    expect(queue[0].owner).toMatchObject({ studentNumber: '99000001' });
    const approved = (await http.post(`/api/v1/devices/${two.id}/approve`).set(admin).send({}).expect(200))
      .body;
    expect(approved).toMatchObject({ status: 'TRUSTED', isAttendanceDevice: true });

    // The old phone is replaced and can no longer sign anything.
    expect((await prisma.userDevice.findUniqueOrThrow({ where: { id: one.id } })).status).toBe('REPLACED');
    expect((await current(studentOne.auth, one.id, first).expect(403)).body.code).toBe('DEVICE_REVOKED');
    expect((await current(studentOne.auth, two.id, second).expect(200)).body.status).toBe('TRUSTED');
    expect(
      await prisma.auditLog.count({
        where: { action: { in: ['devices.registered', 'devices.trust_requested', 'devices.approved'] } },
      }),
    ).toBe(4);
  });

  it('recognises a phone again by its key, and treats a changed key as a new phone', async () => {
    const phone = newPhone();
    const first = (await register(studentOne.auth, phone).expect(200)).body;
    const again = (await register(studentOne.auth, phone, { appVersion: '1.0.1' }).expect(200)).body;
    expect(again).toMatchObject({ id: first.id, appVersion: '1.0.1', status: 'TRUSTED' });
    const otherKey = newPhone();
    const refused = await register(studentOne.auth, { ...phone, publicKey: otherKey.publicKey }).expect(409);
    expect(refused.body.code).toBe('DEVICE_KEY_MISMATCH');
    await register(studentOne.auth, { ...phone, publicKey: 'not-a-key' }).expect(400);
  });

  it('trusts staff phones without making them attendance phones', async () => {
    const phone = newPhone();
    expect((await register(lecturer, phone).expect(200)).body).toMatchObject({
      status: 'TRUSTED',
      isAttendanceDevice: false,
    });
    expect((await register(lecturer, newPhone()).expect(200)).body.status).toBe('TRUSTED');
  });

  it('after a lost phone is revoked, the next phone still needs approval', async () => {
    const lost = (await register(studentOne.auth, newPhone()).expect(200)).body;
    await http.post(`/api/v1/devices/${lost.id}/revoke`).set(admin).send({}).expect(400);
    await http
      .post(`/api/v1/devices/${lost.id}/revoke`)
      .set(admin)
      .send({ reason: 'Reported stolen (test)' })
      .expect(200);
    expect((await register(studentOne.auth, newPhone()).expect(200)).body.status).toBe('PENDING_APPROVAL');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'devices.revoked' } });
    expect(audit.reason).toBe('Reported stolen (test)');
  });

  it('makes only one first phone trusted when two register at the same moment', async () => {
    const results = await Promise.all([
      register(studentOne.auth, newPhone()),
      register(studentOne.auth, newPhone()),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['PENDING_APPROVAL', 'TRUSTED']);
    expect(
      await prisma.userDevice.count({ where: { userId: studentOne.userId, isAttendanceDevice: true } }),
    ).toBe(1);
  });

  it('only approvers see and decide phones', async () => {
    const phone = (await register(studentOne.auth, newPhone()).expect(200)).body;
    await http.get('/api/v1/devices').set(studentOne.auth).expect(403);
    await http
      .post(`/api/v1/devices/${phone.id}/revoke`)
      .set(lecturer)
      .send({ reason: 'Not allowed (test)' })
      .expect(403);
    // A student cannot ask on someone else's phone's behalf.
    const other = (await register(studentTwo.auth, newPhone()).expect(200)).body;
    await http
      .post(`/api/v1/me/devices/${other.id}/request-trust`)
      .set(studentOne.auth)
      .send({ reason: 'Not my phone (test)' })
      .expect(404);
  });
});

describe('signed requests', () => {
  async function trusted() {
    const phone = newPhone();
    const device = (await register(studentOne.auth, phone).expect(200)).body;
    return { phone, device };
  }

  it('accepts a correct signature once, and refuses a replay', async () => {
    const { phone, device } = await trusted();
    const nonce = 'nonce-for-replay-test-0001';
    await current(studentOne.auth, device.id, phone, { nonce }).expect(200);
    const replay = await current(studentOne.auth, device.id, phone, { nonce }).expect(401);
    expect(replay.body.code).toBe('DEVICE_SIGNATURE_REPLAYED');
  });

  it('refuses a missing, wrong or tampered signature', async () => {
    const { phone, device } = await trusted();
    expect((await http.get('/api/v1/me/devices/current').set(studentOne.auth).expect(401)).body.code).toBe(
      'DEVICE_SIGNATURE_REQUIRED',
    );
    // Signed by another key.
    const stranger = newPhone();
    expect((await current(studentOne.auth, device.id, stranger).expect(401)).body.code).toBe(
      'DEVICE_SIGNATURE_INVALID',
    );
    // Signed for a different path, then sent here.
    const headers = signed(device.id, phone.privateKey, 'GET', '/api/v1/me/devices');
    expect(
      (await http.get('/api/v1/me/devices/current').set(studentOne.auth).set(headers).expect(401)).body.code,
    ).toBe('DEVICE_SIGNATURE_INVALID');
  });

  it('refuses a request whose time is more than 5 minutes off', async () => {
    const { phone, device } = await trusted();
    const sixMinutesAgo = clock.now().getTime() - 6 * 60_000;
    expect(
      (await current(studentOne.auth, device.id, phone, { timestamp: sixMinutesAgo }).expect(401)).body.code,
    ).toBe('DEVICE_CLOCK_SKEW');
    const fourMinutesAgo = clock.now().getTime() - 4 * 60_000;
    await current(studentOne.auth, device.id, phone, { timestamp: fourMinutesAgo }).expect(200);
  });

  it('refuses another person’s phone, even with its valid signature', async () => {
    const { phone, device } = await trusted();
    expect((await current(studentTwo.auth, device.id, phone).expect(401)).body.code).toBe('DEVICE_UNKNOWN');
  });

  it('checks the exact body bytes of a signed request', async () => {
    // A signed POST: the body hash is part of what is signed, so a changed body is refused.
    const { phone, device } = await trusted();
    const path = '/api/v1/me/devices/current';
    const headers = signed(device.id, phone.privateKey, 'GET', path, '{"a":1}');
    expect((await http.get(path).set(studentOne.auth).set(headers).expect(401)).body.code).toBe(
      'DEVICE_SIGNATURE_INVALID',
    );
  });
});

describe('risk flags', () => {
  it('flags one phone used by two students for review, once, without blocking anyone', async () => {
    const shared = newPhone();
    await register(studentOne.auth, shared).expect(200);
    const second = (await register(studentTwo.auth, shared).expect(200)).body;
    // Student two's first phone is still trusted for them: flags never block.
    expect(second.status).toBe('TRUSTED');
    await register(studentTwo.auth, shared).expect(200); // recognised again: no new flag

    const flags = (await http.get('/api/v1/risk-flags').set(admin).expect(200)).body.data;
    expect(flags).toHaveLength(1);
    // Student one used the phone moments earlier, so this is a quick switch between accounts.
    expect(flags[0]).toMatchObject({
      type: 'ACCOUNT_SWITCH',
      status: 'OPEN',
      student: { studentNumber: '99000002' },
    });

    await http
      .post(`/api/v1/risk-flags/${flags[0].id}/review`)
      .set(admin)
      .send({ decision: 'DISMISSED' })
      .expect(400);
    const reviewed = (
      await http
        .post(`/api/v1/risk-flags/${flags[0].id}/review`)
        .set(admin)
        .send({ decision: 'DISMISSED', note: 'Siblings sharing a phone (test)' })
        .expect(200)
    ).body;
    expect(reviewed).toMatchObject({ status: 'DISMISSED', reviewNote: 'Siblings sharing a phone (test)' });
    expect(
      (
        await http
          .post(`/api/v1/risk-flags/${flags[0].id}/review`)
          .set(admin)
          .send({ decision: 'CONFIRMED', note: 'Again (test)' })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_REVIEWED');
    await http.get('/api/v1/risk-flags').set(lecturer).expect(403);
  });

  it('calls a phone used by another student more than a day ago a shared phone', async () => {
    const shared = newPhone();
    await register(studentOne.auth, shared).expect(200);
    clock.set('2030-08-21T08:00:00Z');
    await register(studentTwo.auth, shared).expect(200);
    const flags = (await http.get('/api/v1/risk-flags').set(admin).expect(200)).body.data;
    expect(flags.map((f: { type: string }) => f.type)).toEqual(['SHARED_DEVICE']);
  });

  it('flags frequent phone changes: three requests in 90 days', async () => {
    await register(studentOne.auth, newPhone()).expect(200);
    for (let i = 0; i < 3; i++) {
      const phone = (await register(studentOne.auth, newPhone()).expect(200)).body;
      await http
        .post(`/api/v1/me/devices/${phone.id}/request-trust`)
        .set(studentOne.auth)
        .send({ reason: `New phone number ${i + 1} (test)` })
        .expect(200);
    }
    const flags = (await http.get('/api/v1/risk-flags?type=DEVICE_SWITCH').set(admin).expect(200)).body.data;
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toMatchObject({ requestsIn90Days: 3 });
  });
});
