import { BadRequestException, Injectable } from '@nestjs/common';
import type { ClassroomCheckSchema } from '@attendsure/shared';
import type { z } from 'zod';
import type { UserDevice } from '../../generated/prisma/client.js';
import { PlacesService } from '../places/places.service.js';
import { decide } from './decision-engine.js';
import { EvidenceService } from './evidence.service.js';
import { VerificationPolicyService } from './verification-policy.service.js';

/**
 * "Check this classroom" (Phase 4 step 4): runs a phone's real evidence through the real rules and
 * returns the decision, without recording anything. Used to try a room before attendance exists, and
 * for the field test. The request is signed by the phone, so the device status is real too.
 */
@Injectable()
export class ClassroomCheckService {
  constructor(
    private readonly places: PlacesService,
    private readonly policies: VerificationPolicyService,
    private readonly evidence: EvidenceService,
  ) {}

  async check(device: UserDevice, input: z.output<typeof ClassroomCheckSchema>) {
    const room = (await this.places.classroomFacts([input.classroomId])).get(input.classroomId);
    if (!room?.isActive)
      throw new BadRequestException({ code: 'INVALID_CLASSROOM', message: 'No such room in use.' });
    const policy = await this.policies.current();
    const e = await this.evidence.collect(device, input, policy.rules);
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
        ble: e.ble,
        gps: e.gps,
        integrity: e.integrity,
        sharedDeviceInSession: false,
        degradedMode: false,
      },
      policy.rules,
    );
    return {
      policyVersion: policy.version,
      classroom: { id: room.id, code: room.code, name: room.name },
      evidence: {
        ble: e.ble,
        strongestOwnRssi: e.strongestOwnRssi,
        roomBeacons: e.roomBeacons,
        recognisedReadings: e.heard.length,
        gps: e.gps,
        distanceM: e.distanceM,
        hasGeofence: e.hasGeofence,
        device: device.status,
        integrity: e.integrity,
      },
      decision,
    };
  }
}
