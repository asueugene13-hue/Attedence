import { describe, expect, it } from 'vitest';
import { checkToken, makeToken, newQrSecret, parseToken, windowAt, windowEndsAt } from './qr.js';

const SESSION = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const OPENED = new Date('2030-08-20T10:00:00Z');
const at = (seconds: number) => new Date(OPENED.getTime() + seconds * 1000);

describe('attendance QR tokens', () => {
  it('counts windows from the moment attendance opened', () => {
    expect(windowAt(OPENED, at(0), 15)).toBe(0);
    expect(windowAt(OPENED, at(14.9), 15)).toBe(0);
    expect(windowAt(OPENED, at(15), 15)).toBe(1);
    expect(windowAt(OPENED, at(-5), 15)).toBe(0);
    expect(windowEndsAt(OPENED, 1, 15)).toEqual(at(30));
  });

  it('round-trips a token, and accepts the current window and one before it', () => {
    const secret = newQrSecret();
    const token = makeToken(secret, SESSION, 7);
    expect(token).toMatch(/^AS1\.[0-9a-f-]{36}\.7\.[A-Za-z0-9_-]{22}$/);
    const parsed = parseToken(token)!;
    expect(parsed).toMatchObject({ sessionId: SESSION, window: 7 });
    expect(checkToken(parsed, secret, 7, 1)).toEqual({ valid: true, window: 7 });
    expect(checkToken(parsed, secret, 8, 1)).toEqual({ valid: true, window: 7 });
  });

  it('rejects an expired screenshot, a token from the future, and another session’s secret', () => {
    const secret = newQrSecret();
    const parsed = parseToken(makeToken(secret, SESSION, 3))!;
    expect(checkToken(parsed, secret, 5, 1)).toEqual({ valid: false, reason: 'QR_EXPIRED' });
    expect(checkToken(parsed, secret, 2, 1)).toEqual({ valid: false, reason: 'QR_INVALID' });
    expect(checkToken(parsed, newQrSecret(), 3, 1)).toEqual({ valid: false, reason: 'QR_INVALID' });
  });

  it('rejects edited tokens: another session, another window, or a changed signature', () => {
    const secret = newQrSecret();
    const token = makeToken(secret, SESSION, 4);
    const otherSession = parseToken(token.replace(SESSION, OTHER))!;
    expect(checkToken(otherSession, secret, 4, 1).valid).toBe(false);
    const otherWindow = parseToken(token.replace('.4.', '.5.'))!;
    expect(checkToken(otherWindow, secret, 5, 1).valid).toBe(false);
    const parts = token.split('.');
    const flipped = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(checkToken(parseToken([...parts.slice(0, 3), flipped].join('.'))!, secret, 4, 1).valid).toBe(
      false,
    );
  });

  it('reads only well-formed attendance tokens (student ID codes and junk are refused)', () => {
    for (const text of [
      '',
      'hello',
      `ASID1.${SESSION}.1.AAAAAAAAAAAAAAAAAAAAAA`,
      `AS1.not-a-uuid.1.AAAAAAAAAAAAAAAAAAAAAA`,
      `AS1.${SESSION}.-1.AAAAAAAAAAAAAAAAAAAAAA`,
      `AS1.${SESSION}.1.short`,
      `AS1.${SESSION}.1.AAAAAAAAAAAAAAAAAAAAAA.extra`,
    ]) {
      expect(parseToken(text)).toBeNull();
    }
  });
});
