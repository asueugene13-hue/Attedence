import type { VerificationRules } from '@attendsure/shared';
import { distanceM, evaluateGps, type Geofence } from './evidence.js';

/**
 * Beacon health (PRESENCE_VERIFICATION.md §3, Phase 4 step 5). Pure functions over what phones
 * reported, so each rule is tested with fixed examples. They only ever *suggest*: a suspected fault
 * puts the class in degraded mode (check-ins wait for the lecturer), and anomalies become risk flags
 * that a person reviews. Nothing here rejects or punishes anyone.
 */

export interface RoomReport {
  deviceId: string;
  observedAt: Date;
  bluetooth: 'ON' | 'OFF' | 'DENIED';
  gps: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'MOCKED';
  /** Heard at least one of this room's beacons, at any strength. */
  heardRoomBeacon: boolean;
}

export interface FaultAssessment {
  suspected: boolean;
  /** Different phones on site, Bluetooth on, that heard none of the room's beacons. */
  silentDevices: number;
  /** Some phone heard a room beacon in the window, so it is working. */
  heardInWindow: boolean;
}

/**
 * Suspected fault: within the window, at least `beaconFaultMinDevices` different phones that were on
 * site (GPS INSIDE) with Bluetooth on heard none of the room's beacons, and no phone heard one.
 * Phones with Bluetooth off, or not shown on site, prove nothing about the beacon and are not counted.
 */
export function assessRoom(
  reports: RoomReport[],
  now: Date,
  rules: Pick<VerificationRules, 'beaconFaultMinDevices' | 'beaconFaultWindowMinutes'>,
): FaultAssessment {
  const since = now.getTime() - rules.beaconFaultWindowMinutes * 60_000;
  const recent = reports.filter((r) => r.observedAt.getTime() >= since && r.observedAt <= now);
  const heardInWindow = recent.some((r) => r.heardRoomBeacon);
  const silent = new Set(
    recent
      .filter((r) => r.bluetooth === 'ON' && r.gps === 'INSIDE' && !r.heardRoomBeacon)
      .map((r) => r.deviceId),
  );
  return {
    suspected: !heardInWindow && silent.size >= rules.beaconFaultMinDevices,
    silentDevices: silent.size,
    heardInWindow,
  };
}

export interface Located {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

/**
 * Unexpected beacon: a phone heard a beacon while its location is clearly away from that beacon's
 * site (outside the geofence by more than the margin, allowing for the reading's error). Beacons
 * reach tens of metres, so this suggests a copied or moved beacon. Needs a usable, non-mocked reading.
 */
export function isUnexpectedSighting(
  phone: Located | null,
  beaconSite: Geofence | null,
  rules: Pick<VerificationRules, 'gpsMaxUsableAccuracyM' | 'gpsOutsideMarginM'>,
): { unexpected: boolean; distanceM: number | null } {
  if (!phone || !beaconSite) return { unexpected: false, distanceM: null };
  const gps = evaluateGps(phone, beaconSite, rules);
  return { unexpected: gps.result === 'OUTSIDE', distanceM: gps.distanceM };
}

/**
 * Location conflict: the same beacon heard at two places further apart than the policy allows, within
 * the conflict window. Each reading's error is subtracted, so only certain separations count.
 * Returns the furthest such earlier sighting, if any.
 */
export function findConflict<T extends Located>(
  current: Located,
  others: T[],
  rules: Pick<VerificationRules, 'beaconConflictDistanceM'>,
): { other: T; separationM: number } | null {
  let best: { other: T; separationM: number } | null = null;
  for (const other of others) {
    const separation = distanceM(current, other) - current.accuracyM - other.accuracyM;
    if (separation > rules.beaconConflictDistanceM && (!best || separation > best.separationM)) {
      best = { other, separationM: Math.round(separation) };
    }
  }
  return best;
}

/** How far back a conflicting sighting of the same beacon is looked for. */
export const CONFLICT_WINDOW_MINUTES = 5;
/** Health summaries are kept per beacon in windows of this length. */
export const HEALTH_WINDOW_MINUTES = 5;

/** The start of the 5-minute window a moment falls in. */
export function windowStart(at: Date): Date {
  const size = HEALTH_WINDOW_MINUTES * 60_000;
  return new Date(Math.floor(at.getTime() / size) * size);
}

export interface HealthRow {
  beaconId: string;
  windowStart: Date;
  sightings: number;
  distinctDevices: number;
  medianRssi: number | null;
}

/** One summary per beacon and 5-minute window. */
export function summarise(
  sightings: { beaconId: string; deviceId: string; rssi: number; observedAt: Date }[],
): HealthRow[] {
  const groups = new Map<string, { beaconId: string; start: Date; rssi: number[]; devices: Set<string> }>();
  for (const s of sightings) {
    const start = windowStart(s.observedAt);
    const key = `${s.beaconId}|${start.toISOString()}`;
    const g = groups.get(key) ?? { beaconId: s.beaconId, start, rssi: [], devices: new Set() };
    g.rssi.push(s.rssi);
    g.devices.add(s.deviceId);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g.rssi].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    return {
      beaconId: g.beaconId,
      windowStart: g.start,
      sightings: g.rssi.length,
      distinctDevices: g.devices.size,
      medianRssi: sorted.length ? median : null,
    };
  });
}
