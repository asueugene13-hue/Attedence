import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { JobRegistry } from './job-registry.js';
import { JobRunner, RUN_JOBS } from './job-runner.service.js';
import { JobsService } from './jobs.service.js';
import { OutboxService } from './outbox.service.js';
import { SystemEventsService } from './system-events.service.js';

/** What every module may use: declaring jobs, queueing them, the outbox and system events. */
@Global()
@Module({
  providers: [JobRegistry, JobsService, OutboxService, SystemEventsService],
  exports: [JobRegistry, JobsService, OutboxService, SystemEventsService],
})
export class JobsModule {}

/**
 * Runs the jobs. Kept out of the global module on purpose: Nest shuts global modules down last, so
 * the runner stops (and lets running jobs finish) before the database connection closes.
 * `fromConfig` follows RUN_JOBS_IN_API; the worker process passes `always`.
 */
@Module({})
export class JobRunnerModule {
  static forRoot(mode: 'fromConfig' | 'always'): DynamicModule {
    return {
      module: JobRunnerModule,
      providers: [
        mode === 'always'
          ? { provide: RUN_JOBS, useValue: true }
          : {
              provide: RUN_JOBS,
              useFactory: (config: AppConfig) => config.runJobsInApi,
              inject: [AppConfig],
            },
        JobRunner,
      ],
      exports: [JobRunner],
    };
  }
}
