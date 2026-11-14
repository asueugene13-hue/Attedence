import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RiskFlagsModule } from '../risk-flags/risk-flags.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AttendanceEventsService } from './attendance-events.service.js';
import { AttendanceGateway } from './attendance.gateway.js';
import { AttendanceSummaryController } from './attendance-summary.controller.js';
import { AttendanceSummaryService } from './attendance-summary.service.js';
import { AttendanceSessionsController } from './attendance-sessions.controller.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';
import { CheckInController } from './check-in.controller.js';
import { CheckInService } from './check-in.service.js';
import { CorrectionsController } from './corrections.controller.js';
import { CorrectionsService } from './corrections.service.js';
import { AttendanceRecordsService } from './records.service.js';
import { RosterController } from './roster.controller.js';
import { RosterService } from './roster.service.js';

/** Attendance (Phase 5): sessions, the QR, check-in, records and corrections. Owns the attendance tables. */
@Module({
  imports: [
    AcademicModule,
    AuthModule,
    ClassSessionsModule,
    CoursesModule,
    DevicesModule,
    EnrollmentsModule,
    NotificationsModule,
    RiskFlagsModule,
    SettingsModule,
    StudentsModule,
    VerificationModule,
  ],
  controllers: [
    AttendanceSessionsController,
    CheckInController,
    RosterController,
    CorrectionsController,
    AttendanceSummaryController,
  ],
  providers: [
    AttendanceSessionsService,
    CheckInService,
    RosterService,
    AttendanceEventsService,
    AttendanceGateway,
    CorrectionsService,
    AttendanceSummaryService,
    AttendanceRecordsService,
  ],
  exports: [AttendanceSessionsService, AttendanceRecordsService],
})
export class AttendanceModule {}
