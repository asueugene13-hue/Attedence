import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Encrypts secrets kept in the database, such as TOTP keys (AES-256-GCM). GCM also detects tampering:
 * a modified ciphertext fails to decrypt instead of yielding garbage.
 * Format: v1.<iv>.<auth tag>.<ciphertext>, each part base64url.
 */
@Injectable()
export class EncryptionService {
  constructor(private readonly config: AppConfig) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ciphertext]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unrecognised encrypted value');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.config.encryptionKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
