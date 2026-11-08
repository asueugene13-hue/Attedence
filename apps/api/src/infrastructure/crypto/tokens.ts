import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random, URL-safe token with 256 bits of entropy (refresh tokens, activation and reset links). */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of a high-entropy token. The database stores only this, so a leaked database copy does not
 * reveal usable tokens. (Passwords are different: they have low entropy and use Argon2id.)
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison, so response timing reveals nothing about how much of a value matched. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
