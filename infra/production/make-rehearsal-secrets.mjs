// Writes throwaway secrets for a production rehearsal on this computer into infra/production/secrets/
// (ignored by git). Refuses to overwrite existing files, so a running rehearsal keeps its passwords.
//   node infra/production/make-rehearsal-secrets.mjs
// Never use these files for the real system: real secrets come from the host's secret manager.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./secrets/', import.meta.url));
const files = ['app.env', 'rehearsal.env', 's3.json'];
if (files.some((f) => existsSync(dir + f))) {
  console.error(`Secrets already exist in ${dir}. Delete that folder first to make new ones.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const token = (bytes) => randomBytes(bytes).toString('base64url');
const pgPassword = token(24);
const redisPassword = token(24);
const s3Access = `rehearsal-${token(9)}`;
const s3Secret = token(30);

writeFileSync(
  dir + 'rehearsal.env',
  [
    '# Stand-in services for the rehearsal only.',
    'POSTGRES_USER=attendsure',
    `POSTGRES_PASSWORD=${pgPassword}`,
    'POSTGRES_DB=attendsure',
    `REDIS_PASSWORD=${redisPassword}`,
    '',
  ].join('\n'),
);

writeFileSync(
  dir + 'app.env',
  [
    '# AttendSure settings for the production rehearsal (made by make-rehearsal-secrets.mjs).',
    `DATABASE_URL=postgresql://attendsure:${pgPassword}@postgres:5432/attendsure`,
    `REDIS_URL=redis://:${redisPassword}@redis:6379`,
    'S3_ENDPOINT=http://s3:8333',
    'S3_PUBLIC_ENDPOINT=http://localhost:8334',
    `S3_ACCESS_KEY=${s3Access}`,
    `S3_SECRET_KEY=${s3Secret}`,
    'S3_BUCKET=attendsure-rehearsal',
    'SMTP_HOST=mailpit',
    'SMTP_PORT=1025',
    'SMTP_FROM=AttendSure rehearsal <no-reply@localhost>',
    `JWT_ACCESS_SECRET=${token(48)}`,
    `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    `METRICS_TOKEN=${token(36)}`,
    'WEB_APP_URL=https://localhost:8443',
    'INSTITUTION_TIMEZONE=Africa/Accra',
    'LOG_LEVEL=info',
    '',
  ].join('\n'),
);

writeFileSync(
  dir + 's3.json',
  JSON.stringify(
    {
      identities: [
        {
          name: 'attendsure-rehearsal',
          credentials: [{ accessKey: s3Access, secretKey: s3Secret }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
      ],
    },
    null,
    2,
  ) + '\n',
);

console.warn(`Rehearsal secrets written to ${dir} (not committed).`);
