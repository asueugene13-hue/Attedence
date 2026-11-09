import { Module } from '@nestjs/common';
import { INFRASTRUCTURE_MODULES } from './app.module.js';
import { JobRunnerModule } from './infrastructure/jobs/jobs.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AuthorizationModule } from './modules/authorization/authorization.module.js';
import { ClassSessionsModule } from './modules/class-sessions/class-sessions.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';

/**
 * The background worker. It loads the feature modules whose jobs it runs (they declare them at
 * start-up) and always runs the queues and the outbox relay. It serves no HTTP requests.
 */
@Module({
  imports: [
    ...INFRASTRUCTURE_MODULES,
    StorageModule,
    AuthorizationModule,
    // Declares the student activation-email job.
    ImportsModule,
    // Declares the class-session generation job.
    ClassSessionsModule,
    JobRunnerModule.forRoot('always'),
  ],
})
export class WorkerModule {}
