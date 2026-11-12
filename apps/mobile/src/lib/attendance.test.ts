import { ApiError } from './api';
import { type CheckInResult, isAttendanceCode, newIdempotencyKey, qrGrid, submitCheckIn } from './attendance';

const RESULT: CheckInResult = {
  attemptId: 'a',
  outcome: 'VERIFIED',
  reason: null,
  message: 'You’re checked in.',
  retryAllowed: false,
  canAskForReview: false,
  recordStatus: 'PRESENT',
  receivedAt: '2030-08-20T10:01:00.000Z',
};
const offline = () => new ApiError(0, 'NETWORK_ERROR', 'AttendSure could not be reached.');

describe('submitting a check-in', () => {
  it('keeps the same key and retries while offline, then returns the server’s answer', async () => {
    let clock = 0;
    const keys: string[] = [];
    const waiting: boolean[] = [];
    let calls = 0;
    const result = await submitCheckIn(
      async (key) => {
        keys.push(key);
        if (++calls < 3) throw offline();
        return RESULT;
      },
      'key-1',
      (w) => waiting.push(w),
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    expect(result).toEqual(RESULT);
    expect(keys).toEqual(['key-1', 'key-1', 'key-1']);
    expect(waiting).toEqual([true, true, false]);
  });

  it('gives up after two minutes offline, and never retries a refusal', async () => {
    let clock = 0;
    await expect(
      submitCheckIn(
        async () => {
          throw offline();
        },
        'k',
        () => undefined,
        async (ms) => {
          clock += ms;
        },
        () => clock,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(clock).toBeGreaterThanOrEqual(120_000);
    let calls = 0;
    await expect(
      submitCheckIn(
        async () => {
          calls++;
          throw new ApiError(401, 'DEVICE_SIGNATURE_INVALID', 'no');
        },
        'k',
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_SIGNATURE_INVALID' });
    expect(calls).toBe(1);
  });
});

describe('codes and keys', () => {
  it('recognises attendance codes only', () => {
    expect(isAttendanceCode('AS1.01900000-0000-7000-8000-000000000001.12.AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(isAttendanceCode('ASID1.01900000-0000-7000-8000-000000000001.12.AAAAAAAAAAAAAAAAAAAAAA')).toBe(
      false,
    );
    expect(isAttendanceCode('https://example.test')).toBe(false);
  });

  it('makes version-4 UUIDs', () => {
    const key = newIdempotencyKey((n) => Uint8Array.from({ length: n }, (_, i) => i * 17));
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('draws a QR grid', () => {
    const grid = qrGrid('AS1.01900000-0000-7000-8000-000000000001.12.AAAAAAAAAAAAAAAAAAAAAA');
    expect(grid.size).toBeGreaterThanOrEqual(21);
    // The finder pattern's corner is always dark.
    expect(grid.dark(0, 0)).toBe(true);
  });
});
