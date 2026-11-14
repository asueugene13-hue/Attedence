import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { FilesService } from '../src/modules/files/files.service.js';
import { ExportsService } from '../src/modules/reports/exports.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Phase 7 step 4: background-job monitoring, the metrics endpoint and the audit-log export.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const TOKEN = 'metrics-token-for-tests-only-0123456789';
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;

async function start() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .compile();
  const nest = moduleRef.createNestApplication({ logger: false });
  configureApp(nest);
  return nest.init();
}

beforeAll(async () => {
  process.env.METRICS_TOKEN = TOKEN;
  try {
    app = await start();
  } finally {
    delete process.env.METRICS_TOKEN;
  }
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
});

describe('background jobs on the System health page', () => {
  it('shows each schedule’s last success, flags the ones that have not run, and is for system-health readers only', async () => {
    const admin = await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN']);
    // The class-monitoring sweep ran a moment ago; nothing else has ever run (jobs are off in tests).
    await prisma.backgroundJobRecord.create({
      data: {
        queue: 'monitoring',
        name: 'sweep',
        jobId: 'test-1',
        status: 'SUCCEEDED',
        finishedAt: new Date(),
      },
    });
    await prisma.backgroundJobRecord.create({
      data: {
        queue: 'email',
        name: 'notification',
        jobId: 'test-2',
        status: 'DEAD',
        attempts: 5,
        lastError: 'SMTP refused (test)',
        finishedAt: new Date(),
      },
    });
    const jobs = (await http.get('/api/v1/system/jobs').set(admin.auth).expect(200)).body;
    const schedule = (job: string) => jobs.schedules.find((s: { job: string }) => s.job === job);
    expect(schedule('monitoring/sweep')).toMatchObject({
      overdue: false,
      lastSucceededAt: expect.any(String),
    });
    expect(schedule('monitoring/attendance-sweep')).toMatchObject({ overdue: true, lastSucceededAt: null });
    expect(jobs.lastDay).toMatchObject({ SUCCEEDED: 1, DEAD: 1 });
    expect(jobs.recentFailures[0]).toMatchObject({
      name: 'notification',
      status: 'DEAD',
      lastError: 'SMTP refused (test)',
    });
    expect(Object.keys(jobs.queues).sort()).toEqual(['email', 'monitoring', 'system']);
    expect(typeof jobs.outboxWaiting).toBe('number');

    const universityAdmin = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/system/jobs').set(universityAdmin.auth).expect(403);
  });
});

describe('the metrics endpoint', () => {
  it('needs the token, and reports process figures and job counts without personal data', async () => {
    await http.get('/metrics').expect(401);
    await http
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token-of-the-same-length-000000')
      .expect(401);
    const res = await http.get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'attendsure_process_cpu_user_seconds_total',
      'attendsure_job_runs_last_day',
      'attendsure_queue_jobs',
      'attendsure_schedules_overdue',
      'attendsure_outbox_waiting',
      'attendsure_system_events_unacknowledged',
    ]) {
      expect(res.text, name).toContain(name);
    }
    expect(res.text).not.toMatch(/@example\.test/);
  });

  it('is off (404) when no token is set', async () => {
    const plain = await start();
    try {
      await request(plain.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(404);
    } finally {
      await plain.close();
    }
  });
});

describe('the audit-log export', () => {
  it('is for university-wide readers; the file lists the entries asked for; making it is itself logged', async () => {
    const admin = await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN']);
    await prisma.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: admin.user.id,
        actorRoleKey: 'SUPER_ADMIN',
        action: 'settings.updated',
        entityType: 'setting',
        entityId: 'x',
        reason: '=cmd (test)',
      },
    });
    const queued = (
      await http
        .post('/api/v1/reports/exports')
        .set(admin.auth)
        .send({ reportType: 'AUDIT_LOG', format: 'CSV', params: { action: 'settings.' } })
        .expect(201)
    ).body;
    await app.get(ExportsService).make(queued.id);
    const row = await prisma.reportExport.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row).toMatchObject({ status: 'READY', rowCount: 1, containsPersonalData: true });
    const csv = (await app.get(FilesService).read(row.fileId!)).toString('utf8');
    expect(csv).toContain('settings.updated');
    expect(csv).toContain("'=cmd (test)"); // neutralised
    expect(
      await prisma.auditLog.count({ where: { action: 'reports.export_requested', entityId: queued.id } }),
    ).toBe(1);

    const faculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty (test)' } });
    const limited = await signInAs(app, prisma, 'admin.of@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'FACULTY', id: faculty.id },
    });
    const refused = await http
      .post('/api/v1/reports/exports')
      .set(limited.auth)
      .send({ reportType: 'AUDIT_LOG', format: 'CSV', params: {} })
      .expect(403);
    expect(refused.body.code).toBe('SCOPE_REQUIRED');
    const lecturer = await signInAs(app, prisma, 'lecturer@example.test', ['LECTURER']);
    await http
      .post('/api/v1/reports/exports')
      .set(lecturer.auth)
      .send({ reportType: 'AUDIT_LOG', format: 'CSV', params: {} })
      .expect(403);
  });
});
