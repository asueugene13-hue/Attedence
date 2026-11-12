import type { BleResult, GpsResult, VerificationRules } from '@attendsure/shared';

/**
 * Turning raw readings into evidence (PRESENCE_VERIFICATION.md §3, §4). Pure functions: they read only
 * what they are given, so every rule is tested with fixed examples.
 */

export interface GpsReading {
  latitude: number;
  longitude: number;
  /** The phone's own estimate of the error, in metres. */
  accuracyM: number;
  /** Android reports a location that comes from a mock-location app. */
  isMocked?: boolean;
}

export interface Geofence {
  latitude: number;
  longitude: number;
  radiusM: number;
}

export const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). Accurate to well under a metre at campus scale. */
export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * §4: with distance d from the centre, accuracy a, radius r and margin m —
 * MOCKED if a mock-location app supplied it; UNCERTAIN with no reading, no geofence, or accuracy worse
 * than the policy allows; OUTSIDE if d − a > r + m (even the most favourable point is well off site);
 * INSIDE if d ≤ r + a; otherwise UNCERTAIN.
 */
export function evaluateGps(
  reading: GpsReading | null,
  geofence: Geofence | null,
  rules: Pick<VerificationRules, 'gpsMaxUsableAccuracyM' | 'gpsOutsideMarginM'>,
): { result: GpsResult; distanceM: number | null } {
  if (reading?.isMocked) return { result: 'MOCKED', distanceM: null };
  if (!reading || !geofence) return { result: 'UNCERTAIN', distanceM: null };
  const d = distanceM(reading, geofence);
  if (reading.accuracyM > rules.gpsMaxUsableAccuracyM) return { result: 'UNCERTAIN', distanceM: d };
  if (d - reading.accuracyM > geofence.radiusM + rules.gpsOutsideMarginM)
    return { result: 'OUTSIDE', distanceM: d };
  if (d <= geofence.radiusM + reading.accuracyM) return { result: 'INSIDE', distanceM: d };
  return { result: 'UNCERTAIN', distanceM: d };
}

export interface BeaconReading {
  beaconId: string;
  /** The strongest signal heard during the scan, in dBm (closer to 0 is stronger). */
  rssi: number;
}

export interface RegisteredBeacon {
  id: string;
  classroomId: string;
  /** Calibrated threshold: at or above it the phone is inside the room. */
  thresholdRssi: number;
}

/**
 * §3: STRONG if a beacon of this class's room was heard at or above its threshold; WEAK if one was
 * heard below it; OTHER_ROOM if only other rooms' beacons were heard strongly; NONE otherwise; OFF when
 * Bluetooth is off or not allowed. Unregistered beacons are ignored.
 */
export function evaluateBle(
  readings: BeaconReading[],
  beacons: RegisteredBeacon[],
  classroomId: string,
  bluetoothOff: boolean,
): { result: BleResult; strongestOwnRssi: number | null } {
  if (bluetoothOff) return { result: 'OFF', strongestOwnRssi: null };
  const byId = new Map(beacons.map((b) => [b.id, b]));
  const heard = readings.flatMap((r) => {
    const beacon = byId.get(r.beaconId);
    return beacon ? [{ ...r, beacon }] : [];
  });
  const own = heard.filter((h) => h.beacon.classroomId === classroomId);
  const strongestOwnRssi = own.length ? Math.max(...own.map((h) => h.rssi)) : null;
  if (own.some((h) => h.rssi >= h.beacon.thresholdRssi)) return { result: 'STRONG', strongestOwnRssi };
  if (own.length > 0) return { result: 'WEAK', strongestOwnRssi };
  if (heard.some((h) => h.rssi >= h.beacon.thresholdRssi)) return { result: 'OTHER_ROOM', strongestOwnRssi };
  return { result: 'NONE', strongestOwnRssi };
}
