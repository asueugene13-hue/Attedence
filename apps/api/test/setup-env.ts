import { loadLocalEnvFile } from '../src/config/load-env-file.js';
import { testDatabaseUrl, testRedisUrl } from './test-database.js';

// Tests use the local Docker services described in .env (or CI's environment), stay quiet,
// and talk to the separate test database prepared by global-setup.ts.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
loadLocalEnvFile();
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
process.env.REDIS_URL = testRedisUrl(process.env.REDIS_URL);
// A separate storage bucket too, created on first use.
process.env.S3_BUCKET = `${process.env.S3_BUCKET ?? 'attendsure'}-test`;
// Background jobs run inside the test app, and retries wait milliseconds instead of seconds.
process.env.RUN_JOBS_IN_API = 'true';
process.env.JOB_RETRY_DELAY_MS = '20';
// Tests run the monitoring sweep themselves, at the fake clock's time.
process.env.RUN_SCHEDULED_JOBS = 'false';
