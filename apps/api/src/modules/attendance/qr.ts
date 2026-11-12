import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ATTENDANCE_QR_PREFIX } from '@attendsure/shared';

/**
 * The dynamic attendance QR (PRESENCE_VERIFICATION.md §2). The text is
 * `AS1.<sessionId>.<window>.<mac>`: `window` counts rotations since attendance opened, and `mac` is
 * HMAC-SHA-256 of `AS1|knutsford|<sessionId>|<window>` with the session's own secret, cut to 128 bits.
 * The secret never leaves the server, so a token cannot be forged; the window makes it expire.
 */

const CONTEXT = 'knutsford';
const MAC_BYTES = 16;

/** A fresh secret for one attendance session (stored encrypted). */
export const newQrSecret = () => randomBytes(32).toString('base64url');

/** Which rotation `at` falls in (0 at the moment attendance opened). */
export function windowAt(openedAt: Date, at: Date, rotationSeconds: number): number {
  return Math.max(0, Math.floor((at.getTime() - openedAt.getTime()) / (rotationSeconds * 1000)));
}

/** When a window's token stops being the current one. */
export function windowEndsAt(openedAt: Date, window: number, rotationSeconds: number): Date {
  return new Date(openedAt.getTime() + (window + 1) * rotationSeconds * 1000);
}

function mac(secret: string, sessionId: string, window: number): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${ATTENDANCE_QR_PREFIX}|${CONTEXT}|${sessionId}|${window}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

export function makeToken(secret: string, sessionId: string, window: number): string {
  return `${ATTENDANCE_QR_PREFIX}.${sessionId}.${window}.${mac(secret, sessionId, window).toString('base64url')}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads a token's parts without trusting them (the signature is checked separately). */
export function parseToken(text: string): { sessionId: string; window: number; mac: string } | null {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts[0] !== ATTENDANCE_QR_PREFIX) return null;
  const [, sessionId, windowText, macText] = parts as [string, string, string, string];
  if (!UUID.test(sessionId) || !/^\d{1,9}$/.test(windowText) || !/^[A-Za-z0-9_-]{22}$/.test(macText))
    return null;
  return { sessionId, window: Number(windowText), mac: macText };
}

export type TokenCheck =
  { valid: true; window: number } | { valid: false; reason: 'QR_INVALID' | 'QR_EXPIRED' };

/**
 * Checks a parsed token against the session's secret and the server's current window. The current
 * window and `graceWindows` before it are accepted (scan and upload time); anything older is
 * expired, and anything from the future or with a wrong signature is invalid.
 */
export function checkToken(
  token: { sessionId: string; window: number; mac: string },
  secret: string,
  currentWindow: number,
  graceWindows: number,
): TokenCheck {
  const expected = mac(secret, token.sessionId, token.window);
  const given = Buffer.from(token.mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: 'QR_INVALID' };
  }
  if (token.window > currentWindow) return { valid: false, reason: 'QR_INVALID' };
  if (token.window < currentWindow - graceWindows) return { valid: false, reason: 'QR_EXPIRED' };
  return { valid: true, window: token.window };
}
