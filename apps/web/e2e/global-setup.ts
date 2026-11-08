import { spawnSync } from 'node:child_process';
import pg from 'pg';
// @ts-expect-error -- plain JavaScript helper shared with the API start script
import { apiDir, prepareDatabase } from './prepare-db.mjs';

/** Empties the e2e database and creates the first Super Admin with the real one-time command. */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.E2E_DATABASE_URL!;
  await prepareDatabase(databaseUrl);

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(
      'TRUNCATE audit_logs, mfa_recovery_codes, refresh_tokens, auth_sessions, user_tokens, user_devices, user_roles, users CASCADE',
    );
  } finally {
    await db.end();
  }

  // Exactly as an installer would run it. The command prints the activation link on stderr.
  const result = spawnSync(
    process.execPath,
    ['dist/cli/create-super-admin.js', '--email', 'e2e.admin@example.test', '--name', 'E2E Admin (test)'],
    {
      cwd: apiDir as string,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: process.env.E2E_REDIS_URL,
        WEB_APP_URL: 'http://localhost:3101',
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  const token = output.match(/activate\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (result.status !== 0 || !token) {
    throw new Error(`create-super-admin failed (exit ${result.status}): ${output}`);
  }
  process.env.E2E_ACTIVATION_TOKEN = token;
}
