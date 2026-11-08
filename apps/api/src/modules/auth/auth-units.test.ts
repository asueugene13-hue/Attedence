import { describe, expect, it } from 'vitest';
import { AppConfig } from '../../config/app-config.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { hashToken, newOpaqueToken, safeEqual } from '../../infrastructure/crypto/tokens.js';
import { isLocked, lockUntilAfterFailure } from './lockout.js';
import { passwordProblems } from './password.service.js';

const MINUTE = 60_000;

describe('lockout', () => {
  const now = new Date('2026-11-10T10:00:00Z');

  it('does not lock before the 5th consecutive failure', () => {
    for (const n of [0, 1, 2, 3, 4, 6, 9]) expect(lockUntilAfterFailure(n, now)).toBeNull();
  });

  it('locks for 15 min, then doubles, capped at 24 hours', () => {
    const minutes = (n: number) => (lockUntilAfterFailure(n, now)!.getTime() - now.getTime()) / MINUTE;
    expect(minutes(5)).toBe(15);
    expect(minutes(10)).toBe(30);
    expect(minutes(15)).toBe(60);
    expect(minutes(50)).toBe(24 * 60);
  });

  it('knows when a lock has passed', () => {
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date(now.getTime() + MINUTE), now)).toBe(true);
    expect(isLocked(new Date(now.getTime() - 1), now)).toBe(false);
  });
});

describe('password rules', () => {
  it('accepts a reasonable passphrase', () => {
    expect(passwordProblems('river-mango-lantern-42', 'test.person@example.test')).toEqual([]);
  });

  it('rejects common passwords regardless of case', () => {
    expect(passwordProblems('Password123', 'a@example.test')).toHaveLength(1);
    expect(passwordProblems('KNUTSFORD123', 'a@example.test')).toHaveLength(1);
  });

  it('rejects a repeated character and passwords containing the email name', () => {
    expect(passwordProblems('aaaaaaaaaaaa', 'a@example.test')).toContain('cannot be one character repeated');
    expect(passwordProblems('kwesi-is-great-1', 'kwesi@example.test')).toContain(
      'cannot contain your email name',
    );
  });
});

describe('opaque tokens', () => {
  it('are long, unique and hashed consistently', () => {
    const a = newOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newOpaqueToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compare safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('EncryptionService', () => {
  const config = { encryptionKey: Buffer.alloc(32, 9) } as AppConfig;
  const encryption = new EncryptionService(config);

  it('round-trips and never produces the same ciphertext twice', () => {
    const a = encryption.encrypt('JBSWY3DPEHPK3PXP');
    const b = encryption.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(encryption.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering and a wrong key', () => {
    const sealed = encryption.encrypt('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => encryption.decrypt(parts.join('.'))).toThrow();
    const other = new EncryptionService({ encryptionKey: Buffer.alloc(32, 1) } as AppConfig);
    expect(() => other.decrypt(sealed)).toThrow();
  });
});
