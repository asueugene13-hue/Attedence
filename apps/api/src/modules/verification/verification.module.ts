import { Module } from '@nestjs/common';
import { BeaconsModule } from '../beacons/beacons.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { PlacesModule } from '../places/places.module.js';
import { ClassroomCheckController } from './classroom-check.controller.js';
import { ClassroomCheckService } from './classroom-check.service.js';
import { VerificationController } from './verification.controller.js';
import { VerificationPolicyService } from './verification-policy.service.js';

@Module({
  imports: [BeaconsModule, PlacesModule, DevicesModule],
  controllers: [VerificationController, ClassroomCheckController],
  providers: [VerificationPolicyService, ClassroomCheckService],
  exports: [VerificationPolicyService],
})
export class VerificationModule {}
