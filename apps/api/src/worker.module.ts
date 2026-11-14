import { Module } from '@nestjs/common';
import { FEATURE_MODULES, INFRASTRUCTURE_MODULES } from './app.module.js';
import { JobRunnerModule } from './infrastructure/jobs/jobs.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';

/**
 * The background worker. It loads every feature module, because each declares its own jobs when it
 * loads (attendance closing, reminders, notifications, …), and always runs the queues and the outbox
 * relay. It serves no HTTP requests: controllers are loaded but never mounted.
 */
@Module({
  imports: [...INFRASTRUCTURE_MODULES, StorageModule, ...FEATURE_MODULES, JobRunnerModule.forRoot('always')],
})
export class WorkerModule {}
