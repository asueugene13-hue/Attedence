import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JobRegistry } from '../src/infrastructure/jobs/job-registry.js';
import { RUN_JOBS } from '../src/infrastructure/jobs/job-runner.service.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { WorkerModule } from '../src/worker.module.js';

// Phase 8 step 1. In production only the worker runs background jobs (RUN_JOBS_IN_API is off), and a
// module declares its jobs when it loads. The worker once loaded only two modules, so the attendance
// close, reminders, dispute hand-over, excuse application and beacon summaries would never have run.
// This compares what the two processes know. (Neither runs any job here.)
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let api: INestApplicationContext;
let worker: INestApplicationContext;

async function start(module: unknown) {
  const ref = await Test.createTestingModule({ imports: [module as never] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(RUN_JOBS)
    .useValue(false)
    .compile();
  return ref.init();
}

beforeAll(async () => {
  api = await start(AppModule);
  worker = await start(WorkerModule);
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await api?.close();
});

describe('the worker', () => {
  it('knows every job and every schedule the API declares', () => {
    const apiJobs = api.get(JobRegistry);
    const workerJobs = worker.get(JobRegistry);
    expect(workerJobs.definedKeys()).toEqual(apiJobs.definedKeys());
    const schedules = (r: JobRegistry) =>
      r
        .scheduled()
        .map((s) => `${s.queue}/${s.name} every ${s.everyMs} ms`)
        .sort();
    expect(schedules(workerJobs)).toEqual(schedules(apiJobs));
  });

  it('includes the jobs that keep attendance and requests moving', () => {
    const keys = worker.get(JobRegistry).definedKeys();
    for (const job of [
      'monitoring/attendance-sweep',
      'monitoring/attendance-undecided',
      'monitoring/disputes-waiting',
      'monitoring/excuses-apply',
      'monitoring/beacon-health-summary',
      'monitoring/sweep',
      'email/notification',
      'system/notifications-unread-email',
    ]) {
      expect(keys, job).toContain(job);
    }
  });
});
