import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The e2e run uses its own database and Redis database, so it never touches development data.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const devDb = new URL(
  process.env.DATABASE_URL ?? 'postgresql://attendsure:change-me-local-only@localhost:5432/attendsure',
);
devDb.pathname = '/attendsure_e2e';
const e2eRedis = new URL(process.env.REDIS_URL ?? 'redis://:change-me-local-only@localhost:6379');
e2eRedis.pathname = '/2';

export const E2E = {
  apiPort: 3100,
  webPort: 3101,
  databaseUrl: devDb.toString(),
  redisUrl: e2eRedis.toString(),
};
process.env.E2E_DATABASE_URL = E2E.databaseUrl;
process.env.E2E_REDIS_URL = E2E.redisUrl;

const webUrl = `http://localhost:${E2E.webPort}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: webUrl, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      name: 'api',
      command: 'node e2e/start-api.mjs',
      url: `http://localhost:${E2E.apiPort}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        PORT: String(E2E.apiPort),
        DATABASE_URL: E2E.databaseUrl,
        REDIS_URL: E2E.redisUrl,
        WEB_APP_URL: webUrl,
        JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'e2e-only-signing-secret-not-used-anywhere-else',
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64'),
        SMTP_HOST: process.env.SMTP_HOST ?? 'localhost',
        SMTP_PORT: process.env.SMTP_PORT ?? '1025',
        SMTP_FROM: process.env.SMTP_FROM ?? 'AttendSure e2e <no-reply@localhost>',
        S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'local-dev-access-key',
        S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'local-dev-secret-key-not-for-production',
        S3_BUCKET: `${process.env.S3_BUCKET ?? 'attendsure'}-e2e`,
      },
    },
    {
      name: 'web',
      // The /api proxy target is fixed when Next.js builds, so the e2e run builds against the e2e API.
      command: `npx next build && npx next start --port ${E2E.webPort}`,
      url: `${webUrl}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { API_INTERNAL_URL: `http://localhost:${E2E.apiPort}`, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
