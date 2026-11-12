import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AttendanceSessionsController } from './attendance-sessions.controller.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';

/** Attendance (Phase 5): sessions, the QR, records and corrections. Owns the attendance tables. */
@Module({
  imports: [
    AcademicModule,
    ClassSessionsModule,
    CoursesModule,
    EnrollmentsModule,
    SettingsModule,
    VerificationModule,
  ],
  controllers: [AttendanceSessionsController],
  providers: [AttendanceSessionsService],
  exports: [AttendanceSessionsService],
})
export class AttendanceModule {}
