import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';

/** HTTP settings applied in main.ts and in tests, so tests exercise the same app users get. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  const http = app.getHttpAdapter().getInstance() as Express;
  http.disable('x-powered-by');
  app.use(cookieParser());
  app.enableShutdownHooks();
}
