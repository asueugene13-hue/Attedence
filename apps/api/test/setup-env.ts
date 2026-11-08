import { loadLocalEnvFile } from '../src/config/load-env-file.js';
import { testDatabaseUrl, testRedisUrl } from './test-database.js';

// Tests use the local Docker services described in .env (or CI's environment), stay quiet,
// and talk to the separate test database prepared by global-setup.ts.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
loadLocalEnvFile();
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
process.env.REDIS_URL = testRedisUrl(process.env.REDIS_URL);
