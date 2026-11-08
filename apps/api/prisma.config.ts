import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env files by itself. In local development, load the repository's .env.
// In CI and production the variables come from the environment instead.
const rootEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // The seed runs from the built code, so run `npm run build` first.
  migrations: { path: 'prisma/migrations', seed: 'node dist/database/seed.js' },
  datasource: {
    // A placeholder keeps `prisma generate` working without a database; commands that connect need the real URL.
    url: process.env.DATABASE_URL ?? 'postgresql://unset:unset@localhost:5432/unset',
  },
});
