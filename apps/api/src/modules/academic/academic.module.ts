import { Module } from '@nestjs/common';
import { AcademicAccessService } from './academic-access.service.js';
import { AcademicController } from './academic.controller.js';
import { AcademicPeriodsService } from './academic-periods.service.js';
import { AcademicStructureService } from './academic-structure.service.js';

@Module({
  controllers: [AcademicController],
  providers: [AcademicAccessService, AcademicStructureService, AcademicPeriodsService],
  exports: [AcademicAccessService, AcademicStructureService, AcademicPeriodsService],
})
export class AcademicModule {}
