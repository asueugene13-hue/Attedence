import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadLocalEnvFile } from './config/load-env-file.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  loadLocalEnvFile();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('AttendSure worker started: running background jobs and the outbox relay.');
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
