import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AppConfig } from '../config/app-config.js';
import { loadLocalEnvFile } from '../config/load-env-file.js';
import { AttendanceSessionsService } from '../modules/attendance/attendance-sessions.service.js';
import { AuditService } from '../modules/audit-logs/audit.service.js';
import { MfaService } from '../modules/auth/mfa.service.js';
import { BeaconsService } from '../modules/beacons/beacons.service.js';
import { rotateStoredSecrets } from './encryption-rotation.js';

/**
 * Re-encrypts every stored secret with the current ENCRYPTION_KEY, after the key has been changed
 * (docs/RUNBOOK.md §7):
 *   node dist/cli/rotate-encryption-key.js --reason "Scheduled key change, ticket 123"
 * Run it with the new key as ENCRYPTION_KEY and the old one in ENCRYPTION_KEYS_PREVIOUS. When it reports
 * that everything uses the current key, remove the old key from ENCRYPTION_KEYS_PREVIOUS.
 */
async function main(): Promise<void> {
  loadLocalEnvFile();
  const { values } = parseArgs({ options: { reason: { type: 'string' } } });
  const reason = values.reason?.trim() ?? '';
  if (reason.length < 5) {
    console.error(
      'Usage: --reason "<why the key is being changed>" (at least 5 characters; it goes in the audit log)',
    );
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const summary = await rotateStoredSecrets(
      [
        { label: 'two-step sign-in secrets', reencryptSecrets: () => app.get(MfaService).reencryptSecrets() },
        {
          label: 'classroom-code secrets',
          reencryptSecrets: () => app.get(AttendanceSessionsService).reencryptSecrets(),
        },
        { label: 'beacon rotation keys', reencryptSecrets: () => app.get(BeaconsService).reencryptSecrets() },
      ],
      app.get(AuditService),
      app.get(AppConfig).encryptionKey,
      reason,
    );
    console.warn(`Current key: ${summary.keyId}`);
    for (const { label, result } of summary.results) {
      console.warn(
        `  ${label}: ${result.checked} checked, ${result.reencrypted} re-encrypted` +
          (result.skipped ? `, ${result.skipped} changed meanwhile (run again)` : ''),
      );
    }
    console.warn(
      summary.complete
        ? 'Every stored secret uses the current key. The previous key can now be removed from ENCRYPTION_KEYS_PREVIOUS.'
        : 'Some values changed while this ran: run it again before removing the previous key.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
