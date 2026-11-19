import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

const IV_BYTES = 12;

/** A short public fingerprint of a key (not the key), so a value says which key encrypted it. */
export function keyId(key: Buffer): string {
  return createHash('sha256')
    .update('attendsure encryption key id')
    .update(key)
    .digest('base64url')
    .slice(0, 8);
}

/**
 * Encrypts secrets kept in the database, such as TOTP keys (AES-256-GCM). GCM also detects tampering:
 * a modified ciphertext, or one tried with the wrong key, fails to decrypt instead of yielding garbage.
 *
 * Format: v2.<key id>.<iv>.<auth tag>.<ciphertext> (base64url parts). Values written before key changes were
 * possible are v1.<iv>.<auth tag>.<ciphertext>; they are still read, trying each known key.
 *
 * Changing the key (docs/RUNBOOK.md §7): the new key becomes ENCRYPTION_KEY and the old one goes into
 * ENCRYPTION_KEYS_PREVIOUS, so everything stays readable; `rotate-encryption-key` re-encrypts each stored
 * value with the new key; then the old key is removed.
 */
@Injectable()
export class EncryptionService {
  private readonly current: { id: string; key: Buffer };
  private readonly byId: Map<string, Buffer>;

  constructor(config: AppConfig) {
    this.current = { id: keyId(config.encryptionKey), key: config.encryptionKey };
    this.byId = new Map(
      [config.encryptionKey, ...config.previousEncryptionKeys].map((key) => [keyId(key), key] as const),
    );
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v2',
      this.current.id,
      ...[iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString('base64url')),
    ].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts[0] === 'v2' && parts.length === 5) {
      const key = this.byId.get(parts[1]!);
      if (!key) throw new Error('Encrypted with a key that is no longer configured');
      return open(key, parts[2]!, parts[3]!, parts[4]!);
    }
    if (parts[0] === 'v1' && parts.length === 4) {
      // Written before values recorded their key: try each known key; the wrong ones fail their check.
      for (const key of this.byId.values()) {
        try {
          return open(key, parts[1]!, parts[2]!, parts[3]!);
        } catch {
          // not this key
        }
      }
      throw new Error('Encrypted value could not be decrypted with any configured key');
    }
    throw new Error('Unrecognised encrypted value');
  }

  /** Whether a stored value should be re-encrypted: it was not made with the current key in the current format. */
  needsReencryption(payload: string): boolean {
    const parts = payload.split('.');
    return !(parts[0] === 'v2' && parts[1] === this.current.id);
  }

  /** The same secret, encrypted with the current key (for `rotate-encryption-key`). */
  reencrypt(payload: string): string {
    return this.encrypt(this.decrypt(payload));
  }
}

function open(key: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
