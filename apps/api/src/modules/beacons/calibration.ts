import { isInsidePosition, MIN_SURVEY_PHONE_MODELS, type SurveyPosition } from '@attendsure/shared';

export interface Measurement {
  beaconId: string;
  phoneModel: string;
  position: SurveyPosition;
  rssi: number;
}

export type CalibrationProblem =
  'NOT_ENOUGH_PHONES' | 'NO_INSIDE_READINGS' | 'NO_OUTSIDE_READINGS' | 'OVERLAP';

export interface BeaconCalibration {
  beaconId: string;
  phoneModels: number;
  insideReadings: number;
  outsideReadings: number;
  /** The weakest signal measured anywhere inside the room. */
  weakestInside: number | null;
  /** The strongest signal measured anywhere outside it (doorway, corridor, next room, outside). */
  strongestOutside: number | null;
  /** At or above it: inside. Null when a problem prevents a safe threshold. */
  thresholdRssi: number | null;
  problem: CalibrationProblem | null;
}

/**
 * Turns a survey into a threshold per beacon (PRESENCE_VERIFICATION.md §3): halfway between the
 * weakest reading inside the room and the strongest reading outside it, so every inside reading
 * counts as inside and every outside reading as outside. Needs readings from at least three phone
 * models, inside and outside. If the inside and outside readings overlap, no threshold can separate
 * them: the room needs another beacon or a better placement.
 */
export function calibrate(measurements: Measurement[], beaconIds: string[]): BeaconCalibration[] {
  return beaconIds.map((beaconId) => {
    const mine = measurements.filter((m) => m.beaconId === beaconId);
    const inside = mine.filter((m) => isInsidePosition(m.position)).map((m) => m.rssi);
    const outside = mine.filter((m) => !isInsidePosition(m.position)).map((m) => m.rssi);
    const phoneModels = new Set(mine.map((m) => m.phoneModel.trim().toLowerCase())).size;
    const weakestInside = inside.length ? Math.min(...inside) : null;
    const strongestOutside = outside.length ? Math.max(...outside) : null;
    const base = {
      beaconId,
      phoneModels,
      insideReadings: inside.length,
      outsideReadings: outside.length,
      weakestInside,
      strongestOutside,
    };
    const problem: CalibrationProblem | null =
      phoneModels < MIN_SURVEY_PHONE_MODELS
        ? 'NOT_ENOUGH_PHONES'
        : weakestInside === null
          ? 'NO_INSIDE_READINGS'
          : strongestOutside === null
            ? 'NO_OUTSIDE_READINGS'
            : weakestInside <= strongestOutside
              ? 'OVERLAP'
              : null;
    if (problem || weakestInside === null || strongestOutside === null) {
      return { ...base, thresholdRssi: null, problem };
    }
    // Strictly above every outside reading and no higher than the weakest inside reading.
    const thresholdRssi = strongestOutside + Math.ceil((weakestInside - strongestOutside) / 2);
    return { ...base, thresholdRssi, problem: null };
  });
}
