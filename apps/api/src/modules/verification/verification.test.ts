import { DEFAULT_VERIFICATION_RULES as D, type VerificationRules } from '@attendsure/shared';
import { describe, expect, it } from 'vitest';
import { type DecisionInput, decide } from './decision-engine.js';
import { distanceM, evaluateBle, evaluateGps } from './evidence.js';

// PRESENCE_VERIFICATION.md §3, §4, §6 and §7, row by row, with the default policy (§9).
const ok: DecisionInput = {
  qr: 'VALID',
  sessionOpen: true,
  enrolled: true,
  accountActive: true,
  device: 'TRUSTED',
  attemptsSoFar: 0,
  retryRejectionsSoFar: 0,
  ble: 'STRONG',
  gps: 'INSIDE',
  integrity: 'NOT_AVAILABLE',
  sharedDeviceInSession: false,
  degradedMode: false,
};
const run = (input: Partial<DecisionInput>, rules: Partial<VerificationRules> = {}) =>
  decide({ ...ok, ...input }, { ...D, ...rules });

describe('hard gates (§6 step 1)', () => {
  it('rejects with the first failing gate’s reason, in the documented order', () => {
    expect(run({ qr: 'INVALID', sessionOpen: false })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'QR_INVALID',
    });
    expect(run({ qr: 'EXPIRED' }).reason).toBe('QR_EXPIRED');
    expect(run({ sessionOpen: false, enrolled: false }).reason).toBe('SESSION_NOT_OPEN');
    expect(run({ enrolled: false }).reason).toBe('NOT_ENROLLED');
    expect(run({ accountActive: false }).reason).toBe('ACCOUNT_INACTIVE');
    expect(run({ device: 'REVOKED' }).reason).toBe('DEVICE_REVOKED');
    expect(run({ device: 'REPLACED' }).reason).toBe('DEVICE_REVOKED');
    expect(run({ attemptsSoFar: 4 }).outcome).toBe('VERIFIED');
    expect(run({ attemptsSoFar: 5 })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'TOO_MANY_ATTEMPTS',
      retryAllowed: false,
    });
  });

  it('records why in the trace, and gates beat any evidence', () => {
    const d = run({ enrolled: false, ble: 'STRONG', gps: 'INSIDE' });
    expect(d.trace).toEqual(['gate NOT_ENROLLED: student not enrolled in the session’s sections']);
    expect(d.flags).toEqual([]);
    expect(d.message).toBe('You are not enrolled in this class.');
  });
});

describe('the decision table (§6 step 3)', () => {
  it('STRONG + INSIDE or UNCERTAIN + trusted → VERIFIED', () => {
    for (const gps of ['INSIDE', 'UNCERTAIN'] as const) {
      expect(run({ ble: 'STRONG', gps })).toMatchObject({
        outcome: 'VERIFIED',
        reason: null,
        message: 'You’re checked in.',
      });
    }
  });

  it('STRONG (or WEAK) + OUTSIDE → review, with a location-conflict flag', () => {
    for (const ble of ['STRONG', 'WEAK'] as const) {
      expect(run({ ble, gps: 'OUTSIDE' })).toMatchObject({
        outcome: 'MANUAL_REVIEW_REQUIRED',
        reason: 'LOCATION_CONFLICT',
        flags: ['BEACON_LOCATION_CONFLICT'],
      });
    }
  });

  it('STRONG or WEAK + not OUTSIDE + phone waiting for approval → pending, with a device-switch flag', () => {
    for (const ble of ['STRONG', 'WEAK'] as const) {
      for (const gps of ['INSIDE', 'UNCERTAIN'] as const) {
        expect(run({ ble, gps, device: 'PENDING_APPROVAL' })).toMatchObject({
          outcome: 'PENDING_VERIFICATION',
          reason: 'NEW_DEVICE',
          flags: ['DEVICE_SWITCH'],
        });
      }
    }
  });

  it('WEAK + INSIDE or UNCERTAIN + trusted → pending (the lecturer confirms)', () => {
    expect(run({ ble: 'WEAK', gps: 'UNCERTAIN' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'WEAK_SIGNAL',
    });
  });

  it('OTHER_ROOM → rejected with a retry; after a second such rejection, the student may ask for review', () => {
    const first = run({ ble: 'OTHER_ROOM', gps: 'INSIDE' });
    expect(first).toMatchObject({
      outcome: 'REJECTED',
      reason: 'WRONG_ROOM',
      retryAllowed: true,
      canAskForReview: false,
    });
    expect(first.message).toBe('You seem to be in another room. Move into the classroom and try again.');
    expect(run({ ble: 'OTHER_ROOM', retryRejectionsSoFar: 1 }).canAskForReview).toBe(true);
  });

  it('NONE + INSIDE + trusted → pending', () => {
    expect(run({ ble: 'NONE', gps: 'INSIDE' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'NO_CLASSROOM_SIGNAL',
    });
  });

  it('NONE + UNCERTAIN + trusted → rejected with a retry', () => {
    expect(run({ ble: 'NONE', gps: 'UNCERTAIN' })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NO_CLASSROOM_SIGNAL',
      retryAllowed: true,
    });
  });

  it('NONE + OUTSIDE → rejected, no retry', () => {
    expect(run({ ble: 'NONE', gps: 'OUTSIDE' })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NOT_IN_CLASSROOM',
      retryAllowed: false,
    });
  });

  it('Bluetooth off → rejected with a retry and the instruction to turn it on', () => {
    expect(run({ ble: 'OFF' })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'BLUETOOTH_OFF',
      retryAllowed: true,
    });
  });

  it('any + MOCKED → review, with a mock-location flag, even with a strong beacon', () => {
    expect(run({ ble: 'STRONG', gps: 'MOCKED' })).toMatchObject({
      outcome: 'MANUAL_REVIEW_REQUIRED',
      reason: 'MOCK_LOCATION',
      flags: ['MOCK_LOCATION'],
    });
  });
});

describe('modifiers (§6)', () => {
  it('an integrity failure turns VERIFIED into pending and raises a flag; it never rejects', () => {
    expect(run({ integrity: 'FAIL' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'INTEGRITY_FAILED',
      flags: ['INTEGRITY_FAILED'],
    });
    expect(run({ integrity: 'FAIL', ble: 'NONE', gps: 'OUTSIDE' })).toMatchObject({
      outcome: 'REJECTED',
      flags: ['INTEGRITY_FAILED'],
    });
    // Not set up yet: never counts against anyone.
    expect(run({ integrity: 'NOT_AVAILABLE' }).outcome).toBe('VERIFIED');
  });

  it('a phone shared with another student in this session sends both to review', () => {
    expect(run({ sharedDeviceInSession: true })).toMatchObject({
      outcome: 'MANUAL_REVIEW_REQUIRED',
      reason: 'SHARED_DEVICE',
      flags: ['SHARED_DEVICE'],
    });
    // A rejection stays a rejection.
    expect(run({ sharedDeviceInSession: true, ble: 'NONE', gps: 'OUTSIDE' }).outcome).toBe('REJECTED');
  });

  it('degraded mode: a missing beacon is not held against students, but GPS clearly off site still is', () => {
    expect(run({ degradedMode: true, ble: 'NONE', gps: 'INSIDE' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'DEGRADED_MODE',
    });
    expect(run({ degradedMode: true, ble: 'NONE', gps: 'UNCERTAIN' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      reason: 'DEGRADED_MODE',
    });
    expect(run({ degradedMode: true, ble: 'NONE', gps: 'OUTSIDE' })).toMatchObject({
      outcome: 'REJECTED',
      reason: 'NOT_IN_CLASSROOM',
    });
    // A beacon that is heard still counts normally.
    expect(run({ degradedMode: true, ble: 'STRONG' }).outcome).toBe('VERIFIED');
  });
});

describe('the brief’s scenarios (§7)', () => {
  it('at home with a forwarded QR → rejected', () => {
    expect(run({ ble: 'NONE', gps: 'OUTSIDE' }).outcome).toBe('REJECTED');
  });
  it('in the wrong classroom → rejected, retry allowed, then review can be asked', () => {
    expect(run({ ble: 'OTHER_ROOM' })).toMatchObject({ outcome: 'REJECTED', retryAllowed: true });
  });
  it('in the correct classroom → verified', () => {
    expect(run({ ble: 'STRONG', gps: 'INSIDE' }).outcome).toBe('VERIFIED');
  });
  it('GPS inaccurate indoors → still verified: GPS is not held against the student', () => {
    expect(run({ ble: 'STRONG', gps: 'UNCERTAIN' }).outcome).toBe('VERIFIED');
  });
  it('new phone in the right room → pending, and the replacement is flagged for review', () => {
    expect(run({ ble: 'STRONG', device: 'PENDING_APPROVAL' })).toMatchObject({
      outcome: 'PENDING_VERIFICATION',
      flags: ['DEVICE_SWITCH'],
    });
  });
  it('beacon failure → degraded mode, pending for the lecturer', () => {
    expect(run({ ble: 'NONE', gps: 'INSIDE', degradedMode: true }).outcome).toBe('PENDING_VERIFICATION');
  });
});

describe('policy choices (§9)', () => {
  it('a weak beacon can be relaxed to VERIFIED for a calibrated room', () => {
    expect(run({ ble: 'WEAK' }, { bleWeakAction: 'VERIFIED' })).toMatchObject({
      outcome: 'VERIFIED',
      reason: null,
    });
  });
  it('without a required beacon, GPS decides: inside → pending, uncertain → retry, off site → rejected', () => {
    const noBle = { bleRequired: false };
    expect(run({ ble: 'OFF', gps: 'INSIDE' }, noBle).outcome).toBe('PENDING_VERIFICATION');
    expect(run({ ble: 'OFF', gps: 'UNCERTAIN' }, noBle)).toMatchObject({
      outcome: 'REJECTED',
      retryAllowed: true,
    });
    expect(run({ ble: 'NONE', gps: 'OUTSIDE' }, noBle).outcome).toBe('REJECTED');
    expect(run({ ble: 'OFF' }, noBle).trace).toContain('policy: beacon not required');
  });
  it('mock locations can be rejected outright, and new phones sent to review, if the policy says so', () => {
    expect(run({ gps: 'MOCKED' }, { mockLocationAction: 'REJECTED' }).outcome).toBe('REJECTED');
    expect(run({ device: 'PENDING_APPROVAL' }, { newDeviceAction: 'MANUAL_REVIEW_REQUIRED' }).outcome).toBe(
      'MANUAL_REVIEW_REQUIRED',
    );
  });
});

describe('GPS evidence (§4)', () => {
  // A fake campus centre with a 200 m geofence. One degree of latitude is about 111.2 km.
  const campus = { latitude: 5.6, longitude: -0.18, radiusM: 200 };
  const north = (metres: number, accuracyM: number) => ({
    latitude: 5.6 + metres / 111_195,
    longitude: -0.18,
    accuracyM,
  });
  const gps = (reading: Parameters<typeof evaluateGps>[0]) => evaluateGps(reading, campus, D).result;

  it('measures distance correctly', () => {
    expect(distanceM(campus, north(1000, 0))).toBeCloseTo(1000, 0);
  });
  it('INSIDE when the reading is consistent with being on site (d ≤ r + a)', () => {
    expect(gps(north(100, 10))).toBe('INSIDE');
    expect(gps(north(240, 50))).toBe('INSIDE'); // 240 ≤ 200 + 50
  });
  it('OUTSIDE only when even the best point of the error circle is well off site (d − a > r + m)', () => {
    expect(gps(north(330, 100))).toBe('UNCERTAIN'); // 230 is not > 250, and 330 > 300
    expect(gps(north(400, 100))).toBe('OUTSIDE'); // 300 > 250
    expect(gps(north(380, 140))).toBe('UNCERTAIN'); // 240 is not > 250, and 380 > 340
    expect(gps(north(400, 140))).toBe('OUTSIDE'); // 260 > 250
    expect(gps(north(320, 10))).toBe('OUTSIDE'); // 310 > 250
    expect(gps(north(5000, 100))).toBe('OUTSIDE');
  });
  it('UNCERTAIN with no reading, no geofence, or accuracy worse than 150 m', () => {
    expect(gps(null)).toBe('UNCERTAIN');
    expect(evaluateGps(north(5000, 10), null, D).result).toBe('UNCERTAIN');
    expect(gps(north(5000, 151))).toBe('UNCERTAIN');
  });
  it('MOCKED whenever a mock-location app supplied the reading', () => {
    expect(gps({ ...north(10, 5), isMocked: true })).toBe('MOCKED');
  });
});

describe('beacon evidence (§3)', () => {
  const beacons = [
    { id: 'b-room', classroomId: 'room', thresholdRssi: -75 },
    { id: 'b-room-2', classroomId: 'room', thresholdRssi: -80 },
    { id: 'b-next', classroomId: 'next-door', thresholdRssi: -75 },
  ];
  const ble = (readings: { beaconId: string; rssi: number }[], off = false) =>
    evaluateBle(readings, beacons, 'room', off).result;

  it('STRONG at or above the room beacon’s calibrated threshold', () => {
    expect(ble([{ beaconId: 'b-room', rssi: -75 }])).toBe('STRONG');
    expect(
      ble([
        { beaconId: 'b-room', rssi: -90 },
        { beaconId: 'b-room-2', rssi: -79 },
      ]),
    ).toBe('STRONG');
  });
  it('WEAK when the room’s beacon is heard below its threshold', () => {
    expect(ble([{ beaconId: 'b-room', rssi: -76 }])).toBe('WEAK');
  });
  it('OTHER_ROOM when only another room’s beacon is heard strongly', () => {
    expect(ble([{ beaconId: 'b-next', rssi: -60 }])).toBe('OTHER_ROOM');
    // The room's own beacon, even weak, wins over a strong neighbour.
    expect(
      ble([
        { beaconId: 'b-next', rssi: -60 },
        { beaconId: 'b-room', rssi: -85 },
      ]),
    ).toBe('WEAK');
  });
  it('NONE when nothing registered is heard (unknown beacons are ignored) or neighbours only faintly', () => {
    expect(ble([])).toBe('NONE');
    expect(ble([{ beaconId: 'someone-elses-beacon', rssi: -40 }])).toBe('NONE');
    expect(ble([{ beaconId: 'b-next', rssi: -90 }])).toBe('NONE');
  });
  it('OFF when Bluetooth is off or not allowed', () => {
    expect(ble([{ beaconId: 'b-room', rssi: -50 }], true)).toBe('OFF');
  });
});
