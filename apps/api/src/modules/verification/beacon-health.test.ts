import { DEFAULT_VERIFICATION_RULES as RULES } from '@attendsure/shared';
import { describe, expect, it } from 'vitest';
import {
  assessRoom,
  findConflict,
  isUnexpectedSighting,
  type RoomReport,
  summarise,
  windowStart,
} from './beacon-health.js';

// Made-up places: a site centred at an invented point.
const SITE = { latitude: 5.6, longitude: -0.18, radiusM: 200 };
const north = (m: number, accuracyM = 15) => ({ latitude: 5.6 + m / 111_195, longitude: -0.18, accuracyM });
const NOW = new Date('2030-08-19T09:30:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const report = (deviceId: string, over: Partial<RoomReport> = {}): RoomReport => ({
  deviceId,
  observedAt: minutesAgo(2),
  bluetooth: 'ON',
  gps: 'INSIDE',
  heardRoomBeacon: false,
  ...over,
});

describe('suspected beacon fault', () => {
  it('needs three different phones on site, Bluetooth on, hearing nothing', () => {
    expect(assessRoom([report('a'), report('b')], NOW, RULES)).toMatchObject({
      suspected: false,
      silentDevices: 2,
    });
    expect(assessRoom([report('a'), report('b'), report('c')], NOW, RULES)).toMatchObject({
      suspected: true,
      silentDevices: 3,
    });
  });

  it('counts each phone once', () => {
    const same = [report('a'), report('a', { observedAt: minutesAgo(1) }), report('b')];
    expect(assessRoom(same, NOW, RULES).suspected).toBe(false);
  });

  it('ignores phones that prove nothing: Bluetooth off, or not shown on site', () => {
    const reports = [
      report('a'),
      report('b'),
      report('c', { bluetooth: 'OFF' }),
      report('d', { bluetooth: 'DENIED' }),
      report('e', { gps: 'UNCERTAIN' }),
      report('f', { gps: 'OUTSIDE' }),
      report('g', { gps: 'MOCKED' }),
    ];
    expect(assessRoom(reports, NOW, RULES)).toMatchObject({ suspected: false, silentDevices: 2 });
  });

  it('is not suspected if any phone heard the beacon in the window', () => {
    const reports = [
      report('a'),
      report('b'),
      report('c'),
      report('d', { heardRoomBeacon: true, gps: 'UNCERTAIN' }),
    ];
    expect(assessRoom(reports, NOW, RULES)).toMatchObject({ suspected: false, heardInWindow: true });
  });

  it('only looks at the window', () => {
    const old = [report('a', { observedAt: minutesAgo(11) }), report('b'), report('c')];
    expect(assessRoom(old, NOW, RULES).suspected).toBe(false);
    // An old sighting does not clear a beacon that is silent now.
    const heardLongAgo = [
      report('x', { heardRoomBeacon: true, observedAt: minutesAgo(15) }),
      report('a'),
      report('b'),
      report('c'),
    ];
    expect(assessRoom(heardLongAgo, NOW, RULES).suspected).toBe(true);
    // The policy's numbers are used.
    expect(
      assessRoom([report('a'), report('b')], NOW, { beaconFaultMinDevices: 2, beaconFaultWindowMinutes: 10 })
        .suspected,
    ).toBe(true);
  });
});

describe('unexpected beacon', () => {
  it('is a sighting clearly away from the beacon’s site, allowing for the reading’s error', () => {
    expect(isUnexpectedSighting(north(100), SITE, RULES).unexpected).toBe(false);
    expect(isUnexpectedSighting(north(260), SITE, RULES).unexpected).toBe(false); // within radius + margin + error
    expect(isUnexpectedSighting(north(3000), SITE, RULES)).toMatchObject({ unexpected: true });
    expect(isUnexpectedSighting(north(3000, 2900), SITE, RULES).unexpected).toBe(false); // too imprecise
    expect(isUnexpectedSighting(null, SITE, RULES).unexpected).toBe(false);
    expect(isUnexpectedSighting(north(3000), null, RULES).unexpected).toBe(false); // no site set
  });
});

describe('location conflict', () => {
  it('finds the same beacon heard further apart than the policy allows, after subtracting errors', () => {
    const here = north(0);
    expect(findConflict(here, [north(500)], RULES)).toBeNull();
    expect(findConflict(here, [north(1040, 30)], RULES)).toBeNull(); // 1040 − 15 − 30 = 995
    const far = findConflict(here, [north(1500), north(5000)], RULES);
    expect(far?.separationM).toBe(4970);
  });
});

describe('health summaries', () => {
  it('summarises per beacon and 5-minute window, with the median signal', () => {
    const at = (m: number) => new Date(Date.UTC(2030, 7, 19, 9, m, 30));
    const rows = summarise([
      { beaconId: 'b1', deviceId: 'p1', rssi: -60, observedAt: at(0) },
      { beaconId: 'b1', deviceId: 'p1', rssi: -70, observedAt: at(1) },
      { beaconId: 'b1', deviceId: 'p2', rssi: -65, observedAt: at(4) },
      { beaconId: 'b1', deviceId: 'p3', rssi: -80, observedAt: at(5) },
      { beaconId: 'b2', deviceId: 'p1', rssi: -50, observedAt: at(2) },
      { beaconId: 'b2', deviceId: 'p2', rssi: -55, observedAt: at(3) },
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          beaconId: 'b1',
          windowStart: new Date(Date.UTC(2030, 7, 19, 9, 0)),
          sightings: 3,
          distinctDevices: 2,
          medianRssi: -65,
        },
        {
          beaconId: 'b1',
          windowStart: new Date(Date.UTC(2030, 7, 19, 9, 5)),
          sightings: 1,
          distinctDevices: 1,
          medianRssi: -80,
        },
        {
          beaconId: 'b2',
          windowStart: new Date(Date.UTC(2030, 7, 19, 9, 0)),
          sightings: 2,
          distinctDevices: 2,
          medianRssi: -52,
        }, // −52.5 rounds up
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(windowStart(new Date('2030-08-19T09:14:59Z')).toISOString()).toBe('2030-08-19T09:10:00.000Z');
  });
});
