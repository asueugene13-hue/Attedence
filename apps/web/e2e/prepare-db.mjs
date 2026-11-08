// Creates the e2e database if it does not exist and applies every migration. Safe to run repeatedly.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const apiDir = fileURLToPath(new URL('../../api', import.meta.url));

export async function prepareDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } catch (error) {
    // Another process may have created it a moment earlier.
    if (error.code !== '42P04') throw error;
  } finally {
    await client.end();
  }

  const prismaCli = createRequire(`${apiDir}/package.json`).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
    stdio: 'pipe',
  });
}
