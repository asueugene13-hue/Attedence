import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../config/app-config.js';
import { loadLocalEnvFile } from '../config/load-env-file.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedSystemRoles } from './seed-system-roles.js';

/** `npm run db:seed -w @attendsure/api`: loads system roles and permissions. */
async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = AppConfig.fromEnv(process.env);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    const summary = await seedSystemRoles(prisma);
    console.warn(
      `Seed complete: ${summary.rolesCreated} roles created, ${summary.permissionsCreated} permissions created, ` +
        `${summary.permissionsUpdated} updated, ${summary.grantsAdded} default grants added.`,
    );
    if (summary.unknownPermissions.length > 0) {
      console.warn(
        `Not in the catalogue (left untouched, review them): ${summary.unknownPermissions.join(', ')}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
