import QRCode from 'qrcode';
import { ApiError } from './api';

/** Attendance on the phone (Phase 5 step 6). The server decides; the phone collects and shows. */

export interface OpenAttendance {
  attendanceSessionId: string;
  classSessionId: string;
  course: { code: string; title: string } | null;
  closesAt: string;
  lateAfter: string;
  myStatus: string | null;
}

export interface CheckInResult {
  attemptId: string | null;
  outcome: 'VERIFIED' | 'PENDING_VERIFICATION' | 'MANUAL_REVIEW_REQUIRED' | 'REJECTED';
  reason: string | null;
  message: string;
  retryAllowed: boolean;
  canAskForReview: boolean;
  recordStatus: string | null;
  receivedAt: string;
}

export const OUTCOME_DISPLAY: Record<
  CheckInResult['outcome'],
  { title: string; tone: 'success' | 'info' | 'error' }
> = {
  VERIFIED: { title: 'Checked in', tone: 'success' },
  PENDING_VERIFICATION: { title: 'Waiting for your lecturer', tone: 'info' },
  MANUAL_REVIEW_REQUIRED: { title: 'Your check-in needs review', tone: 'info' },
  REJECTED: { title: 'Not checked in', tone: 'error' },
};

export const RECORD_LABELS: Record<string, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  PENDING: 'Waiting for the lecturer',
  UNDER_REVIEW: 'Needs review',
  REJECTED: 'Not accepted',
  ABSENT: 'Absent',
  EXCUSED: 'Excused',
  VOIDED: 'Voided',
};

/** Attendance codes start with this; anything else (a web link, a student ID code) is not one. */
export const isAttendanceCode = (text: string) =>
  /^AS1\.[0-9a-f-]{36}\.\d{1,9}\.[A-Za-z0-9_-]{22}$/.test(text.trim());

/** How long the phone keeps trying after losing the connection (ATTENDANCE_FLOW §8). */
export const OFFLINE_RETRY_MS = 120_000;
const RETRY_EVERY_MS = 5_000;

/**
 * Sends a check-in, keeping the same idempotency key on every try, so a request that did reach the
 * server is never counted twice. On a lost connection it keeps trying for up to two minutes, telling
 * the screen it is waiting; any answer from the server (even a refusal) ends it.
 */
export async function submitCheckIn(
  send: (key: string) => Promise<CheckInResult>,
  key: string,
  onWaiting: (waiting: boolean) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<CheckInResult> {
  const started = now();
  for (;;) {
    try {
      const result = await send(key);
      onWaiting(false);
      return result;
    } catch (error) {
      const offline = error instanceof ApiError && error.code === 'NETWORK_ERROR';
      if (!offline || now() - started >= OFFLINE_RETRY_MS) throw error;
      onWaiting(true);
      await wait(RETRY_EVERY_MS);
    }
  }
}

/** A random UUID (v4) for the Idempotency-Key header. */
export function newIdempotencyKey(random: (n: number) => Uint8Array): string {
  const b = random(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The QR's grid of dark squares, for drawing it (lecturer's phone). */
export function qrGrid(text: string): { size: number; dark: (x: number, y: number) => boolean } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, dark: (x, y) => Boolean(qr.modules.get(y, x)) };
}
