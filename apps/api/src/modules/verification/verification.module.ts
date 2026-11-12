import { Module } from '@nestjs/common';
import { BeaconsModule } from '../beacons/beacons.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { RiskFlagsModule } from '../risk-flags/risk-flags.module.js';
import { BeaconHealthController } from './beacon-health.controller.js';
import { BeaconHealthService } from './beacon-health.service.js';
import { DevicesModule } from '../devices/devices.module.js';
import { PlacesModule } from '../places/places.module.js';
import { ClassroomCheckController } from './classroom-check.controller.js';
import { ClassroomCheckService } from './classroom-check.service.js';
import { EvidenceService } from './evidence.service.js';
import { IntegrityVerifier, NotAvailableIntegrityVerifier } from './integrity.js';
import { VerificationController } from './verification.controller.js';
import { VerificationPolicyService } from './verification-policy.service.js';

@Module({
  imports: [BeaconsModule, PlacesModule, DevicesModule, ClassSessionsModule, RiskFlagsModule],
  controllers: [VerificationController, ClassroomCheckController, BeaconHealthController],
  providers: [
    VerificationPolicyService,
    ClassroomCheckService,
    EvidenceService,
    BeaconHealthService,
    // Switched to the real Play Integrity / App Attest checks when the accounts exist.
    { provide: IntegrityVerifier, useClass: NotAvailableIntegrityVerifier },
  ],
  exports: [VerificationPolicyService, BeaconHealthService, IntegrityVerifier, EvidenceService],
})
export class VerificationModule {}
