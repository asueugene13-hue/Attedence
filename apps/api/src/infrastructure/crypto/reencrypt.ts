import type { EncryptionService } from './encryption.service.js';

export interface ReencryptResult {
  /** Encrypted values looked at. */
  checked: number;
  /** Values re-encrypted with the current key. */
  reencrypted: number;
  /** Values changed by someone else meanwhile (left as they are; run again to cover them). */
  skipped: number;
}

/**
 * Re-encrypts every value of one encrypted column with the current key, in pages of 500 ordered by id.
 * Each module calls this for its own column (CLAUDE.md rule 8). `save` must update only if the stored
 * value is still `before`, so a concurrent change is never overwritten; it returns whether it updated.
 */
export async function reencryptColumn(
  encryption: EncryptionService,
  load: (afterId: string | undefined) => Promise<{ id: string; value: string }[]>,
  save: (id: string, before: string, after: string) => Promise<boolean>,
): Promise<ReencryptResult> {
  const result: ReencryptResult = { checked: 0, reencrypted: 0, skipped: 0 };
  let afterId: string | undefined;
  for (;;) {
    const rows = await load(afterId);
    if (rows.length === 0) return result;
    for (const row of rows) {
      result.checked++;
      if (!encryption.needsReencryption(row.value)) continue;
      if (await save(row.id, row.value, encryption.reencrypt(row.value))) result.reencrypted++;
      else result.skipped++;
    }
    afterId = rows.at(-1)!.id;
  }
}

export const REENCRYPT_PAGE = 500;
