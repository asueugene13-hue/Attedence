import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { RiskFlagsModule } from '../risk-flags/risk-flags.module.js';
import { StudentsModule } from '../students/students.module.js';
import { DeviceSignatureGuard } from './device-signature.guard.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({
  imports: [AcademicModule, StudentsModule, RiskFlagsModule],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceSignatureGuard],
  exports: [DevicesService, DeviceSignatureGuard],
})
export class DevicesModule {}
