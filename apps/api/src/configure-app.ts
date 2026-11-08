import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppConfig } from './config/app-config.js';

/** HTTP settings applied in main.ts and in tests, so tests exercise the same app users get. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });

  const http = app.getHttpAdapter().getInstance() as Express;
  http.disable('x-powered-by');
  // Behind a load balancer, the client's real IP arrives in X-Forwarded-For. Trust only the configured hops,
  // otherwise anyone could fake their IP and dodge rate limits.
  http.set('trust proxy', config.trustProxyHops);

  // Security headers. This server only returns JSON, so no content may be loaded or framed from it.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.enableShutdownHooks();
}
