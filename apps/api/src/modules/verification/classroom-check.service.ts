import { BadRequestException, Injectable } from '@nestjs/common';
import type { ClassroomCheckSchema } from '@attendsure/shared';
import type { z } from 'zod';
import type { UserDevice } from '../../generated/prisma/client.js';
import { BeaconsService } from '../beacons/beacons.service.js';
import { PlacesService } from '../places/places.service.js';
import { decide } from './decision-engine.js';
import { evaluateBle, evaluateGps, type RegisteredBeacon } from './evidence.js';
import { VerificationPolicyService } from './verification-policy.service.js';

/**
 * "Check this classroom" (Phase 4 step 4): runs a phone's real evidence through the real rules and
 * returns the decision, without recording anything. Used to try a room before attendance exists, and
 * for the field test. The request is signed by the phone, so the device status is real too.
 */
@Injectable()
export class ClassroomCheckService {
  constructor(
    private readonly beacons: BeaconsService,
    private readonly places: PlacesService,
    private readonly policies: VerificationPolicyService,
  ) {}

  async check(device: UserDevice, input: z.output<typeof ClassroomCheckSchema>) {
    const room = (await this.places.classroomFacts([input.classroomId])).get(input.classroomId);
    if (!room?.isActive)
      throw new BadRequestException({ code: 'INVALID_CLASSROOM', message: 'No such room in use.' });
    const [policy, scanList, geofence] = await Promise.all([
      this.policies.current(),
      this.beacons.scanList(),
      this.places.geofenceForClassroom(input.classroomId),
    ]);

    // What the phone heard, matched to registered beacons by identifier. An uncalibrated beacon can
    // be heard, but never counts as strong.
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
      input.location
        ? {
            latitude: input.location.latitude,
            longitude: input.location.longitude,
            accuracyM: input.location.accuracyM,
            isMocked: input.location.isMocked,
          }
        : null,
      geofence ? { latitude: geofence.lat, longitude: geofence.lng, radiusM: geofence.radiusM } : null,
      policy.rules,
    );
    const decision = decide(
      {
        // A classroom check has no QR or attendance session: those gates are for check-in (Phase 5).
        qr: 'VALID',
        sessionOpen: true,
        enrolled: true,
        accountActive: true,
        device: device.status,
        attemptsSoFar: 0,
        retryRejectionsSoFar: 0,
        ble: ble.result,
        gps: gps.result,
        integrity: 'NOT_AVAILABLE',
        sharedDeviceInSession: false,
        degradedMode: false,
      },
      policy.rules,
    );
    const roomBeacons = scanList.filter((b) => b.classroomId === input.classroomId);
    return {
      policyVersion: policy.version,
      classroom: { id: room.id, code: room.code, name: room.name },
      evidence: {
        ble: ble.result,
        strongestOwnRssi: ble.strongestOwnRssi,
        roomBeacons: roomBeacons.map((b) => ({ id: b.id, thresholdRssi: b.thresholdRssi })),
        recognisedReadings: heard.length,
        gps: gps.result,
        distanceM: gps.distanceM === null ? null : Math.round(gps.distanceM),
        hasGeofence: geofence !== null,
        device: device.status,
      },
      decision,
    };
  }
}
