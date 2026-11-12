import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { RiskFlagsModule } from '../risk-flags/risk-flags.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AttendanceSessionsController } from './attendance-sessions.controller.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';
import { CheckInController } from './check-in.controller.js';
import { CheckInService } from './check-in.service.js';

/** Attendance (Phase 5): sessions, the QR, check-in, records and corrections. Owns the attendance tables. */
@Module({
  imports: [
    AcademicModule,
    ClassSessionsModule,
    CoursesModule,
    DevicesModule,
    EnrollmentsModule,
    RiskFlagsModule,
    SettingsModule,
    StudentsModule,
    VerificationModule,
  ],
  controllers: [AttendanceSessionsController, CheckInController],
  providers: [AttendanceSessionsService, CheckInService],
  exports: [AttendanceSessionsService],
})
export class AttendanceModule {}
