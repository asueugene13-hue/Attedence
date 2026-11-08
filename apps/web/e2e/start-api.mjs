// Playwright starts web servers before global setup, so the API's start command prepares its own database.
import { spawn } from 'node:child_process';
import { apiDir, prepareDatabase } from './prepare-db.mjs';

await prepareDatabase(process.env.DATABASE_URL);
const api = spawn(process.execPath, ['dist/main.js'], { cwd: apiDir, stdio: 'inherit', env: process.env });
api.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => api.kill(signal));
