import { loadLocalEnvFile } from '../src/config/load-env-file.js';

// Tests use the local Docker services described in .env (or CI's environment) and stay quiet.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
loadLocalEnvFile();
