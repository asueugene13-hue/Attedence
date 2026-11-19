import { keyId } from '../infrastructure/crypto/encryption.service.js';
import type { ReencryptResult } from '../infrastructure/crypto/reencrypt.js';
import type { AuditService } from '../modules/audit-logs/audit.service.js';

export interface SecretOwner {
  /** What the module keeps encrypted, in plain words. */
  label: string;
  reencryptSecrets(): Promise<ReencryptResult>;
}

export interface RotationSummary {
  keyId: string;
  results: { label: string; result: ReencryptResult }[];
  /** True when every stored secret now uses the current key, so previous keys can be removed. */
  complete: boolean;
}

/**
 * Re-encrypts every stored secret with the current ENCRYPTION_KEY (RUNBOOK.md §7), asking each owning
 * module to do its own table, and records one audit entry with the counts (never the secrets or keys).
 * Safe to run again: values already under the current key are left alone.
 */
export async function rotateStoredSecrets(
  owners: SecretOwner[],
  audit: AuditService,
  currentKey: Buffer,
  reason: string,
): Promise<RotationSummary> {
  const results: RotationSummary['results'] = [];
  for (const owner of owners) results.push({ label: owner.label, result: await owner.reencryptSecrets() });
  const summary: RotationSummary = {
    keyId: keyId(currentKey),
    results,
    complete: results.every((r) => r.result.skipped === 0),
  };
  await audit.record({
    action: 'security.encryption_key_rotated',
    entityType: 'encryption_key',
    entityId: summary.keyId,
    after: {
      keyId: summary.keyId,
      complete: summary.complete,
      results: results.map((r) => ({ label: r.label, ...r.result })),
    },
    reason,
  });
  return summary;
}
