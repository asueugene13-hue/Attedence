import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { loadLocalEnvFile } from '../src/config/load-env-file.js';
import { testDatabaseUrl } from './test-database.js';

/** Runs once before all test files: creates the test database if needed and applies every migration. */
export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  loadLocalEnvFile();
  const url = new URL(testDatabaseUrl(process.env.DATABASE_URL));
  const name = url.pathname.slice(1);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }

  // Run Prisma's CLI script with this Node directly: no shell, so nothing is re-interpreted.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.toString(), PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
    stdio: 'pipe',
  });
}
