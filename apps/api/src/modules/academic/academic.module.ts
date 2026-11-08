import { Module } from '@nestjs/common';
import { AcademicAccessService } from './academic-access.service.js';
import { AcademicLookupsService } from './academic-lookups.service.js';
import { AcademicController } from './academic.controller.js';
import { AcademicPeriodsService } from './academic-periods.service.js';
import { AcademicStructureService } from './academic-structure.service.js';

@Module({
  controllers: [AcademicController],
  providers: [
    AcademicAccessService,
    AcademicStructureService,
    AcademicPeriodsService,
    AcademicLookupsService,
  ],
  exports: [AcademicAccessService, AcademicStructureService, AcademicPeriodsService, AcademicLookupsService],
})
export class AcademicModule {}
