import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { FakeClock } from '../src/infrastructure/clock/clock.js';
import { JobRegistry } from '../src/infrastructure/jobs/job-registry.js';
import { JobsService } from '../src/infrastructure/jobs/jobs.service.js';
import { OutboxService } from '../src/infrastructure/jobs/outbox.service.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let superAdmin: Record<string, string>;

// Test-only jobs, declared once for the whole file.
const handled: string[] = [];
let failuresLeft = 0;

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
  const registry = app.get(JobRegistry);
  registry.define<{ word: string }>({
    queue: 'system',
    name: 'test-echo',
    handle: async (data) => void handled.push(data.word),
  });
  registry.define<{ word: string }>({
    queue: 'system',
    name: 'test-flaky',
    attempts: 3,
    handle: async (data) => {
      if (failuresLeft-- > 0) throw new Error(`deliberate failure for ${data.word}`);
      handled.push(data.word);
    },
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  handled.length = 0;
  failuresLeft = 0;
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  superAdmin = (await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN'])).auth;
});

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

describe('outbox and background jobs', () => {
  it('runs a job written in the same transaction as the change, and records it', async () => {
    await prisma.$transaction((tx) =>
      app.get(OutboxService).add(tx, 'system', 'test-echo', { word: 'hello' }),
    );
    await until(async () => handled.includes('hello'), 'the job to run');
    const outbox = await prisma.outboxEvent.findFirstOrThrow();
    expect(outbox.publishedAt).not.toBeNull();
    await until(
      async () =>
        (await prisma.backgroundJobRecord.findFirst({ where: { name: 'test-echo' } }))?.status ===
        'SUCCEEDED',
      'the job record to say SUCCEEDED',
    );
    const record = await prisma.backgroundJobRecord.findFirstOrThrow({ where: { name: 'test-echo' } });
    expect(record).toMatchObject({ queue: 'system', attempts: 1, idempotencyKey: `outbox:${outbox.id}` });
  });

  it('never runs a job whose transaction rolled back', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await app.get(OutboxService).add(tx, 'system', 'test-echo', { word: 'never' });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    await new Promise((r) => setTimeout(r, 1200));
    expect(handled).not.toContain('never');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('queues a job only once for the same idempotency key', async () => {
    const jobs = app.get(JobsService);
    const first = await jobs.enqueue('system', 'test-echo', { word: 'once' }, { idempotencyKey: 'same-key' });
    const second = await jobs.enqueue(
      'system',
      'test-echo',
      { word: 'once' },
      { idempotencyKey: 'same-key' },
    );
    expect(second.id).toBe(first.id);
    await until(async () => handled.includes('once'), 'the job to run');
    expect(await prisma.backgroundJobRecord.count()).toBe(1);
  });

  it('retries a failing job and succeeds when the problem clears', async () => {
    failuresLeft = 2;
    await app.get(JobsService).enqueue('system', 'test-flaky', { word: 'third-time' });
    await until(async () => handled.includes('third-time'), 'the third try to succeed');
    await until(
      async () => (await prisma.backgroundJobRecord.findFirst())?.status === 'SUCCEEDED',
      'the record to say SUCCEEDED',
    );
    expect((await prisma.backgroundJobRecord.findFirstOrThrow()).attempts).toBe(3);
    expect(await prisma.systemEvent.count()).toBe(0);
  });

  it('gives up after the last try, raises a system event, and staff can acknowledge it', async () => {
    failuresLeft = 99;
    await app.get(JobsService).enqueue('system', 'test-flaky', { word: 'doomed' });
    await until(
      async () => (await prisma.backgroundJobRecord.findFirst())?.status === 'DEAD',
      'the job to be DEAD',
    );
    const record = await prisma.backgroundJobRecord.findFirstOrThrow();
    expect(record.lastError).toContain('deliberate failure');
    await until(async () => (await prisma.systemEvent.count()) === 1, 'the system event');

    const events = (await http.get('/api/v1/system-events?unacknowledged=true').set(superAdmin).expect(200))
      .body.data;
    expect(events[0]).toMatchObject({ type: 'job.dead', severity: 'HIGH', source: 'system/test-flaky' });
    await http.post(`/api/v1/system-events/${events[0].id}/acknowledge`).set(superAdmin).expect(200);
    await http.post(`/api/v1/system-events/${events[0].id}/acknowledge`).set(superAdmin).expect(200);
    expect(
      (await http.get('/api/v1/system-events?unacknowledged=true').set(superAdmin).expect(200)).body.data,
    ).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'system_events.acknowledged' } })).toBe(1);
  });
});

describe('institution settings (D-13 monitoring values)', () => {
  const put = (key: string, body: object, version?: number) => {
    const req = http.put(`/api/v1/settings/${key}`).set(superAdmin);
    if (version !== undefined) req.set('If-Match', String(version));
    return req.send(body);
  };

  it('shows the approved defaults until someone changes them', async () => {
    const list = (await http.get('/api/v1/settings').set(superAdmin).expect(200)).body;
    const byKey = Object.fromEntries(list.map((s: { key: string }) => [s.key, s]));
    expect(byKey['monitoring.unconfirmedAfterMinutes']).toMatchObject({
      value: 15,
      isDefault: true,
      version: 0,
    });
    expect(byKey['monitoring.reviewAfterMinutes']).toMatchObject({ value: 30, isDefault: true });
    expect(byKey['monitoring.reportMinStudents']).toMatchObject({ value: 3 });
    expect(byKey['monitoring.reportMinPercent']).toMatchObject({ value: 10 });
  });

  it('changes a value with a reason and version, audited, and refuses bad or stale changes', async () => {
    const key = 'monitoring.unconfirmedAfterMinutes';
    await put(key, { value: 20, reason: 'Campus is large (test)' }).expect(400); // no If-Match
    await put(key, { value: 20 }, 0).expect(400); // no reason
    await put(key, { value: 2, reason: 'Too short (test)' }, 0).expect(400);
    expect((await put(key, { value: 30, reason: 'Same as review (test)' }, 0).expect(400)).body.code).toBe(
      'INCONSISTENT_SETTINGS',
    );
    await put('monitoring.nonsense', { value: 1, reason: 'Unknown key (test)' }, 0).expect(400);

    const changed = (await put(key, { value: 20, reason: 'Campus is large (test)' }, 0).expect(200)).body;
    expect(changed).toMatchObject({ value: 20, version: 1, isDefault: false });
    expect(await app.get(SettingsService).get(key)).toBe(20);
    expect((await put(key, { value: 25, reason: 'Stale (test)' }, 0).expect(409)).body.code).toBe(
      'VERSION_CONFLICT',
    );
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.changed' } });
    expect(audit).toMatchObject({
      entityId: key,
      reason: 'Campus is large (test)',
      before: { value: 15 },
      after: { value: 20 },
    });
  });

  it('is limited to the Super Admin', async () => {
    const { auth } = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/settings').set(auth).expect(403);
  });
});

describe('test clock', () => {
  it('can be set and moved forward, for simulated teaching days', () => {
    const clock = new FakeClock('2030-09-02T08:00:00Z');
    clock.advanceMinutes(16);
    expect(clock.now().toISOString()).toBe('2030-09-02T08:16:00.000Z');
    clock.set('2030-09-02T10:00:00Z');
    expect(clock.now().toISOString()).toBe('2030-09-02T10:00:00.000Z');
  });
});
