import type { SurveyPosition } from '@attendsure/shared';
import { describe, expect, it } from 'vitest';
import { calibrate, type Measurement } from './calibration.js';

// PRESENCE_VERIFICATION.md §3: threshold between the weakest inside and the strongest outside reading.
const PHONES = ['Phone A (test)', 'Phone B (test)', 'Phone C (test)'];
const at = (
  position: SurveyPosition,
  rssi: number,
  phoneModel = PHONES[0]!,
  beaconId = 'b1',
): Measurement => ({
  beaconId,
  phoneModel,
  position,
  rssi,
});
/** The same readings from each of the three phones. */
const fromAllPhones = (readings: [SurveyPosition, number][], beaconId = 'b1') =>
  PHONES.flatMap((phone) => readings.map(([p, rssi]) => at(p, rssi, phone, beaconId)));

describe('calibration (§3)', () => {
  it('sets the threshold halfway between the weakest inside and strongest outside reading', () => {
    const [result] = calibrate(
      fromAllPhones([
        ['INSIDE_FRONT', -55],
        ['INSIDE_BACK_ROW', -72],
        ['INSIDE_CORNER', -70],
        ['DOORWAY', -80],
        ['CORRIDOR', -86],
        ['NEIGHBOUR_ROOM', -84],
      ]),
      ['b1'],
    );
    expect(result).toMatchObject({
      phoneModels: 3,
      insideReadings: 9,
      outsideReadings: 9,
      weakestInside: -72,
      strongestOutside: -80,
      thresholdRssi: -76,
      problem: null,
    });
  });

  it('keeps every inside reading inside and every outside reading outside, even with a one-dBm gap', () => {
    const [result] = calibrate(
      fromAllPhones([
        ['INSIDE_BACK_ROW', -70],
        ['DOORWAY', -71],
      ]),
      ['b1'],
    );
    expect(result!.thresholdRssi).toBe(-70); // -70 ≥ -70 inside; -71 < -70 outside
  });

  it('refuses a threshold when inside and outside readings overlap (another beacon or placement is needed)', () => {
    const [result] = calibrate(
      fromAllPhones([
        ['INSIDE_BACK_ROW', -78],
        ['CORRIDOR', -75],
      ]),
      ['b1'],
    );
    expect(result).toMatchObject({ thresholdRssi: null, problem: 'OVERLAP' });
    const [equal] = calibrate(
      fromAllPhones([
        ['INSIDE_BACK_ROW', -75],
        ['CORRIDOR', -75],
      ]),
      ['b1'],
    );
    expect(equal!.problem).toBe('OVERLAP');
  });

  it('needs at least three phone models (names compared without case or spaces)', () => {
    const twoPhones = [
      at('INSIDE_FRONT', -60, 'Phone A'),
      at('CORRIDOR', -90, 'phone a '),
      at('INSIDE_BACK_ROW', -70, 'Phone B'),
    ];
    expect(calibrate(twoPhones, ['b1'])[0]).toMatchObject({
      phoneModels: 2,
      problem: 'NOT_ENOUGH_PHONES',
      thresholdRssi: null,
    });
  });

  it('needs readings both inside and outside the room', () => {
    expect(calibrate(fromAllPhones([['INSIDE_FRONT', -60]]), ['b1'])[0]!.problem).toBe('NO_OUTSIDE_READINGS');
    expect(calibrate(fromAllPhones([['CORRIDOR', -90]]), ['b1'])[0]!.problem).toBe('NO_INSIDE_READINGS');
  });

  it('calibrates each beacon in a room on its own readings', () => {
    const results = calibrate(
      [
        ...fromAllPhones(
          [
            ['INSIDE_FRONT', -60],
            ['CORRIDOR', -90],
          ],
          'b1',
        ),
        ...fromAllPhones(
          [
            ['INSIDE_BACK_ROW', -65],
            ['NEIGHBOUR_ROOM', -95],
          ],
          'b2',
        ),
      ],
      ['b1', 'b2', 'b3'],
    );
    expect(results.map((r) => [r.beaconId, r.thresholdRssi, r.problem])).toEqual([
      ['b1', -75, null],
      ['b2', -80, null],
      ['b3', null, 'NOT_ENOUGH_PHONES'],
    ]);
  });
});
