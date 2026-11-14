import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { StudentsModule } from '../students/students.module.js';
import { RiskFlagsController } from './risk-flags.controller.js';
import { RiskFlagsService } from './risk-flags.service.js';

@Module({
  imports: [AcademicModule, StudentsModule],
  controllers: [RiskFlagsController],
  providers: [RiskFlagsService],
  exports: [RiskFlagsService],
})
export class RiskFlagsModule {}
