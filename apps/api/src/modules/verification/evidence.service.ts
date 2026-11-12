import { Injectable } from '@nestjs/common';
import type { BleResult, GpsResult, IntegrityResult, VerificationRules } from '@attendsure/shared';
import type { UserDevice } from '../../generated/prisma/client.js';
import { BeaconsService } from '../beacons/beacons.service.js';
import { PlacesService } from '../places/places.service.js';
import { evaluateBle, evaluateGps, type GpsReading, type RegisteredBeacon } from './evidence.js';
import { IntegrityVerifier } from './integrity.js';

export interface PhoneEvidence {
  classroomId: string;
  bluetooth: 'ON' | 'OFF' | 'DENIED';
  readings: { identifier: string; rssi: number }[];
  location: GpsReading | null;
}

export interface CollectedEvidence {
  ble: BleResult;
  strongestOwnRssi: number | null;
  /** Registered beacons heard (matched from identifiers), for beacon health. */
  heard: { beaconId: string; rssi: number }[];
  roomBeacons: { id: string; thresholdRssi: number | null }[];
  gps: GpsResult;
  distanceM: number | null;
  hasGeofence: boolean;
  integrity: IntegrityResult;
}

/**
 * Turns what a phone reported into evidence (PRESENCE_VERIFICATION §3–§5), for "Check this
 * classroom" and for check-in alike, so both judge a room in exactly the same way.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly beacons: BeaconsService,
    private readonly places: PlacesService,
    private readonly integrity: IntegrityVerifier,
  ) {}

  async collect(
    device: UserDevice,
    input: PhoneEvidence,
    rules: VerificationRules,
  ): Promise<CollectedEvidence> {
    const [scanList, geofence, integrity] = await Promise.all([
      this.beacons.scanList(),
      this.places.geofenceForClassroom(input.classroomId),
      // No platform token is sent yet; the real checks arrive with the integrity accounts.
      this.integrity.verify({ platform: device.platform, token: null }),
    ]);
    // Readings matched to registered beacons by identifier. An uncalibrated beacon can be heard,
    // but never counts as strong.
    const byIdentifier = new Map(scanList.map((b) => [b.identifier, b]));
    const registered: RegisteredBeacon[] = scanList.map((b) => ({
      id: b.id,
      classroomId: b.classroomId,
      thresholdRssi: b.thresholdRssi ?? Number.POSITIVE_INFINITY,
    }));
    const heard = input.readings.flatMap((r) => {
      const beacon = byIdentifier.get(r.identifier);
      return beacon ? [{ beaconId: beacon.id, rssi: r.rssi }] : [];
    });
    const ble = evaluateBle(heard, registered, input.classroomId, input.bluetooth !== 'ON');
    const gps = evaluateGps(
      input.location,
      geofence ? { latitude: geofence.lat, longitude: geofence.lng, radiusM: geofence.radiusM } : null,
      rules,
    );
    return {
      ble: ble.result,
      strongestOwnRssi: ble.strongestOwnRssi,
      heard,
      roomBeacons: scanList
        .filter((b) => b.classroomId === input.classroomId)
        .map((b) => ({ id: b.id, thresholdRssi: b.thresholdRssi })),
      gps: gps.result,
      distanceM: gps.distanceM === null ? null : Math.round(gps.distanceM),
      hasGeofence: geofence !== null,
      integrity,
    };
  }
}
