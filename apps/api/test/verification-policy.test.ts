import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_VERIFICATION_RULES } from '@attendsure/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// The versioned verification policy (PRESENCE_VERIFICATION.md §9).
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let superAdmin: Record<string, string>;

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
  superAdmin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
});

const save = (auth: Record<string, string>, rules: object, reason = 'Calibrated rooms (test)') =>
  http.post('/api/v1/verification-policies').set(auth).send({ rules, reason });

describe('the verification policy', () => {
  it('starts with the documented defaults as version 0', async () => {
    const current = (await http.get('/api/v1/verification-policies/current').set(superAdmin).expect(200))
      .body;
    expect(current).toMatchObject({ version: 0, rules: DEFAULT_VERIFICATION_RULES });
    expect(current.rules).toMatchObject({
      bleRequired: true,
      qrRotationSeconds: 15,
      gpsMaxUsableAccuracyM: 150,
    });
  });

  it('saves each change as a new version with a reason; old versions stay as they were', async () => {
    await save(superAdmin, { bleWeakAction: 'VERIFIED' }, '').expect(400);
    await save(superAdmin, { bleWeakAction: 'SOMETHING' }).expect(400);
    await save(superAdmin, { qrRotationSeconds: 5 }).expect(400); // outside 10–30
    const v1 = (await save(superAdmin, { bleWeakAction: 'VERIFIED' }).expect(201)).body;
    // Rules not given take their defaults, so a version is always complete.
    expect(v1).toMatchObject({
      version: 1,
      rules: { ...DEFAULT_VERIFICATION_RULES, bleWeakAction: 'VERIFIED' },
    });
    const v2 = (await save(superAdmin, { maxAttemptsPerSession: 3 }, 'Fewer retries (test)').expect(201))
      .body;
    expect(v2.version).toBe(2);
    const history = (await http.get('/api/v1/verification-policies').set(superAdmin).expect(200)).body.data;
    expect(history.map((v: { version: number }) => v.version)).toEqual([2, 1, 0]);
    expect(history[1].rules.bleWeakAction).toBe('VERIFIED');
    expect(history[0].rules.bleWeakAction).toBe('PENDING_VERIFICATION');
    const audit = await prisma.auditLog.findMany({ where: { action: 'verification_policies.created' } });
    expect(audit.map((a) => a.reason).sort()).toEqual(['Calibrated rooms (test)', 'Fewer retries (test)']);
  });

  it('never lets a saved version be edited or deleted (database trigger)', async () => {
    await save(superAdmin, {}).expect(201);
    await expect(
      prisma.verificationPolicy.updateMany({ data: { reason: 'Changed later' } }),
    ).rejects.toThrow();
    await expect(prisma.verificationPolicy.deleteMany({})).rejects.toThrow();
  });

  it('gives two saves at the same moment different version numbers', async () => {
    const results = await Promise.all([save(superAdmin, {}), save(superAdmin, {})]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await prisma.verificationPolicy.findMany()).map((p) => p.version).sort()).toEqual([1, 2]);
  });

  it('lets only a Super Admin turn off the beacon requirement', async () => {
    // A University Administrator who has been given the (configurable) policy permission.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const perm = await prisma.permission.findUniqueOrThrow({
      where: { key: 'verification_policies.manage' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const admin = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await save(admin.auth, { gpsOutsideMarginM: 75 }).expect(201);
    expect((await save(admin.auth, { bleRequired: false }).expect(403)).body.code).toBe(
      'SUPER_ADMIN_REQUIRED',
    );
    expect(
      (await save(superAdmin, { bleRequired: false }, 'Beacon trial not finished (test)').expect(201)).body
        .rules.bleRequired,
    ).toBe(false);
  });

  it('is managed only by people with the permission', async () => {
    const registrar = (await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR'])).auth;
    await http.get('/api/v1/verification-policies/current').set(registrar).expect(403);
    await save(registrar, {}).expect(403);
  });

  it('lets an administrator try a case against the current policy, without saving anything', async () => {
    const tryIt = (body: object) =>
      http.post('/api/v1/verification-policies/try').set(superAdmin).send(body).expect(200);
    expect((await tryIt({ ble: 'STRONG', gps: 'UNCERTAIN' })).body).toMatchObject({
      policyVersion: 0,
      outcome: 'VERIFIED',
      message: 'You’re checked in.',
    });
    expect((await tryIt({ ble: 'WEAK', gps: 'INSIDE' })).body.outcome).toBe('PENDING_VERIFICATION');
    await save(superAdmin, { bleWeakAction: 'VERIFIED' }).expect(201);
    const after = (await tryIt({ ble: 'WEAK', gps: 'INSIDE' })).body;
    expect(after).toMatchObject({ policyVersion: 1, outcome: 'VERIFIED' });
    expect(after.trace.length).toBeGreaterThan(1);
    await http
      .post('/api/v1/verification-policies/try')
      .set(superAdmin)
      .send({ ble: 'LOUD', gps: 'INSIDE' })
      .expect(400);
  });
});
