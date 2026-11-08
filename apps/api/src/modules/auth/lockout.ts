/** After every 5th wrong password in a row the account locks: 15 min, then 30, 60 … up to 24 hours. */
export const LOCKOUT_THRESHOLD = 5;
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

/** When the account should unlock after this failure, or null if this failure does not lock it. */
export function lockUntilAfterFailure(consecutiveFailures: number, now: Date): Date | null {
  if (consecutiveFailures <= 0 || consecutiveFailures % LOCKOUT_THRESHOLD !== 0) return null;
  const level = consecutiveFailures / LOCKOUT_THRESHOLD;
  const duration = Math.min(BASE_LOCK_MS * 2 ** (level - 1), MAX_LOCK_MS);
  return new Date(now.getTime() + duration);
}

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}
