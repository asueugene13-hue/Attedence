import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { STUDENT_ID_QR_PREFIX } from '@attendsure/shared';

/**
 * The student ID code: `ASID1.<ref>.<expires>.<mac>`. `ref` is random (it means nothing without the
 * server's short-lived lookup), `expires` is in Unix seconds, and `mac` is HMAC-SHA-256 of
 * `ASID1|knutsford|<ref>|<expires>`, cut to 128 bits, with a key derived only for student IDs.
 */
const MAC_BYTES = 16;
const REF = /^[A-Za-z0-9_-]{22}$/;

/** A key for student ID codes only, derived from the server's encryption key (HKDF-SHA-256). */
export function idCodeKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', encryptionKey, Buffer.alloc(0), 'attendsure student-id code v1', 32));
}

const mac = (key: Buffer, ref: string, expires: number) =>
  createHmac('sha256', key)
    .update(`${STUDENT_ID_QR_PREFIX}|knutsford|${ref}|${expires}`)
    .digest()
    .subarray(0, MAC_BYTES);

export function newRef(): string {
  return randomBytes(16).toString('base64url');
}

export function makeIdCode(key: Buffer, ref: string, expires: number): string {
  return `${STUDENT_ID_QR_PREFIX}.${ref}.${expires}.${mac(key, ref, expires).toString('base64url')}`;
}

/** The reference and expiry of a genuine code, or null for anything forged, edited or malformed. */
export function readIdCode(key: Buffer, code: string): { ref: string; expires: number } | null {
  const parts = code.split('.');
  if (parts.length !== 4 || parts[0] !== STUDENT_ID_QR_PREFIX) return null;
  const [, ref, expiresText, macText] = parts as [string, string, string, string];
  if (!REF.test(ref) || !/^\d{1,12}$/.test(expiresText)) return null;
  const expires = Number(expiresText);
  const given = Buffer.from(macText, 'base64url');
  const expected = mac(key, ref, expires);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { ref, expires };
}
