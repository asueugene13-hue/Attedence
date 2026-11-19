import { createCipheriv, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { rotateStoredSecrets, type SecretOwner } from '../src/cli/encryption-rotation.js';
import { AppConfig, ConfigError } from '../src/config/app-config.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { EncryptionService, keyId } from '../src/infrastructure/crypto/encryption.service.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { AttendanceSessionsService } from '../src/modules/attendance/attendance-sessions.service.js';
import { AuditService } from '../src/modules/audit-logs/audit.service.js';
import { MfaService } from '../src/modules/auth/mfa.service.js';
import { BeaconsService } from '../src/modules/beacons/beacons.service.js';
import { buildClass } from './attendance-fixture.js';
import { resetDatabase, resetRedis } from './fixtures.js';

// Changing ENCRYPTION_KEY (RUNBOOK.md §7): values made with the old key stay readable while it is listed in
// ENCRYPTION_KEYS_PREVIOUS; `rotate-encryption-key` re-encrypts them; then the old key can go.
// Obviously fake keys and data.
const KEY_A = Buffer.alloc(32, 0xa1).toString('base64');
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64');
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T10:01:00Z');

function configWith(current: string, previous: string[] = []) {
  return AppConfig.fromEnv({
    ...process.env,
    ENCRYPTION_KEY: current,
    ENCRYPTION_KEYS_PREVIOUS: previous.join(','),
  });
}

async function appWith(current: string, previous: string[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(AppConfig)
    .useValue(configWith(current, previous))
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

function ownersOf(app: INestApplication): SecretOwner[] {
  return [
    { label: 'two-step sign-in secrets', reencryptSecrets: () => app.get(MfaService).reencryptSecrets() },
    {
      label: 'classroom-code secrets',
      reencryptSecrets: () => app.get(AttendanceSessionsService).reencryptSecrets(),
    },
    { label: 'beacon rotation keys', reencryptSecrets: () => app.get(BeaconsService).reencryptSecrets() },
  ];
}

const MFA_SECRET = 'JBSWY3DPEHPK3PXP';
const BEACON_KEY = '00112233445566778899aabbccddeeff';
let stored: { userId: string; beaconId: string; attendanceId: string; lecturerAuth: Record<string, string> };
let qrSecret: string;

async function storedValues(prisma: PrismaService) {
  const [user, beacon, session] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: stored.userId } }),
    prisma.beacon.findUniqueOrThrow({ where: { id: stored.beaconId } }),
    prisma.attendanceSession.findUniqueOrThrow({ where: { id: stored.attendanceId } }),
  ]);
  return { mfa: user.mfaSecretEnc!, beacon: beacon.rotationKeyEnc!, qr: session.qrSecretEnc };
}

beforeAll(async () => {
  // 1. A system running on key A: a two-step secret, a rotating beacon key and an open attendance session.
  const appA = await appWith(KEY_A);
  try {
    const prisma = appA.get(PrismaService);
    await resetDatabase(prisma);
    await resetRedis(appA.get(RedisService));
    const http = request(appA.getHttpServer());
    const c = await buildClass(appA, prisma, http, { students: 1 });
    const enc = appA.get(EncryptionService);
    await prisma.user.update({
      where: { id: c.admin.userId },
      data: { mfaSecretEnc: enc.encrypt(MFA_SECRET) },
    });
    await prisma.beacon.update({
      where: { id: c.beaconId },
      data: { protocol: 'VENDOR_ROTATING', rotationKeyEnc: enc.encrypt(BEACON_KEY) },
    });
    const opened = await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ startClass: true })
      .expect(201);
    stored = {
      userId: c.admin.userId,
      beaconId: c.beaconId,
      attendanceId: opened.body.id,
      lecturerAuth: c.lecturer.auth,
    };
    qrSecret = enc.decrypt((await storedValues(prisma)).qr);
  } finally {
    await appA.close();
  }
}, 120_000);

afterAll(async () => undefined);

describe('changing the encryption key', () => {
  it('refuses a previous key that is the current one', () => {
    expect(() => configWith(KEY_A, [KEY_A])).toThrow(ConfigError);
  });

  it('reads old values while the old key is listed, re-encrypts them all, and then needs only the new key', async () => {
    // 2. The new key is current, the old one listed as previous: everything is still readable.
    const appB = await appWith(KEY_B, [KEY_A]);
    try {
      const prisma = appB.get(PrismaService);
      const enc = appB.get(EncryptionService);
      const before = await storedValues(prisma);
      expect(enc.decrypt(before.mfa)).toBe(MFA_SECRET);
      expect(enc.decrypt(before.beacon)).toBe(BEACON_KEY);
      expect(enc.needsReencryption(before.mfa)).toBe(true);

      const summary = await rotateStoredSecrets(
        ownersOf(appB),
        appB.get(AuditService),
        appB.get(AppConfig).encryptionKey,
        'Test key change',
      );
      expect(summary.complete).toBe(true);
      expect(summary.keyId).toBe(keyId(Buffer.from(KEY_B, 'base64')));
      for (const { result } of summary.results) {
        expect(result.reencrypted).toBe(result.checked);
        expect(result.checked).toBeGreaterThan(0);
      }
      const after = await storedValues(prisma);
      for (const value of Object.values(after)) expect(value.startsWith(`v2.${summary.keyId}.`)).toBe(true);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'security.encryption_key_rotated' },
      });
      expect(entry.reason).toBe('Test key change');
      expect(JSON.stringify(entry.after)).not.toContain(MFA_SECRET);
      expect(JSON.stringify(entry.after)).not.toContain(KEY_A);

      // Running it again changes nothing.
      const again = await rotateStoredSecrets(
        ownersOf(appB),
        appB.get(AuditService),
        appB.get(AppConfig).encryptionKey,
        'Again',
      );
      expect(again.results.every((r) => r.result.reencrypted === 0)).toBe(true);
    } finally {
      await appB.close();
    }

    // 3. The old key removed: every secret still works, including the classroom code of the open session.
    const appC = await appWith(KEY_B);
    try {
      const enc = appC.get(EncryptionService);
      const values = await storedValues(appC.get(PrismaService));
      expect(enc.decrypt(values.mfa)).toBe(MFA_SECRET);
      expect(enc.decrypt(values.beacon)).toBe(BEACON_KEY);
      expect(enc.decrypt(values.qr)).toBe(qrSecret);
      await request(appC.getHttpServer())
        .get(`/api/v1/attendance-sessions/${stored.attendanceId}/qr`)
        .set(stored.lecturerAuth)
        .expect(200);
    } finally {
      await appC.close();
    }
  }, 120_000);

  it('cannot read values with only the old key once they are re-encrypted, and never yields garbage', () => {
    const oldOnly = new EncryptionService(configWith(KEY_A));
    const newer = new EncryptionService(configWith(KEY_B, [KEY_A]));
    const value = newer.encrypt('secret');
    expect(() => oldOnly.decrypt(value)).toThrow(/no longer configured/);
    // A changed character is caught by GCM's check.
    const parts = value.split('.');
    parts[4] = (parts[4]![0] === 'A' ? 'B' : 'A') + parts[4]!.slice(1);
    expect(() => newer.decrypt(parts.join('.'))).toThrow();
  });

  it('still reads values written in the original format (v1), with the current or a previous key', () => {
    const v1 = (key: string, text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
      const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ct.toString('base64url'),
      ].join('.');
    };
    const enc = new EncryptionService(configWith(KEY_B, [KEY_A]));
    expect(enc.decrypt(v1(KEY_A, 'old'))).toBe('old');
    expect(enc.decrypt(v1(KEY_B, 'new'))).toBe('new');
    expect(enc.needsReencryption(v1(KEY_B, 'new'))).toBe(true);
    expect(() => new EncryptionService(configWith(KEY_B)).decrypt(v1(KEY_A, 'old'))).toThrow(
      /any configured key/,
    );
  });
});
