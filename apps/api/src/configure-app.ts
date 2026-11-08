import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';

/** HTTP settings applied in main.ts and in tests, so tests exercise the same app users get. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');
  app.enableShutdownHooks();
}
