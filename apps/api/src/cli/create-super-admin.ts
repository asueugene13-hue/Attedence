import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../config/app-config.js';
import { loadLocalEnvFile } from '../config/load-env-file.js';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  BootstrapInputSchema,
  BootstrapRefusedError,
  bootstrapSuperAdmin,
} from '../modules/users/bootstrap-super-admin.js';

/**
 * One-time command run on the server by whoever installs AttendSure:
 *   npm run admin:create-super-admin -w @attendsure/api -- --email someone@university.example --name "Full Name"
 * It prints an activation link. Treat the link like a password: give it only to that person.
 */
async function main(): Promise<void> {
  loadLocalEnvFile();
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const parsed = BootstrapInputSchema.safeParse({ email: values.email, fullName: values.name });
  if (!parsed.success) {
    console.error('Usage: --email <address> --name "<full name>"');
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    process.exit(2);
  }

  const config = AppConfig.fromEnv(process.env);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    const result = await bootstrapSuperAdmin(prisma, parsed.data);
    console.warn(
      [
        '',
        `Super Admin account created for ${parsed.data.email} (not active yet).`,
        '',
        'Send this activation link to that person only. It works once and expires',
        `${result.activationExpiresAt.toISOString()}:`,
        '',
        `  ${config.webAppUrl}/activate?token=${result.activationToken}`,
        '',
        'They will choose a password, then set up two-step sign-in the first time they sign in.',
        '',
      ].join('\n'),
    );
  } catch (error) {
    if (error instanceof BootstrapRefusedError) {
      console.error(`Refused: ${error.message}`);
      process.exit(3);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
