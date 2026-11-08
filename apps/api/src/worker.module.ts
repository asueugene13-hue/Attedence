import { Module } from '@nestjs/common';
import { INFRASTRUCTURE_MODULES } from './app.module.js';

/**
 * The background worker: class monitoring, notifications, imports and reports run here from Phase 2–3.
 * For now it only proves the worker can start, reach the database and Redis, and shut down cleanly.
 */
@Module({
  imports: [...INFRASTRUCTURE_MODULES],
})
export class WorkerModule {}
