import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { FilesModule } from '../files/files.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { ReportBuilder } from './report-builder.js';

/**
 * Reports and analytics (Phase 7). Owns the export log (report_exports). The numbers come from the
 * modules that own the data (attendance, class sessions, enrolments), with the requester's access.
 */
@Module({
  imports: [
    AcademicModule,
    AttendanceModule,
    AuthModule,
    ClassSessionsModule,
    EnrollmentsModule,
    FilesModule,
    NotificationsModule,
    SettingsModule,
  ],
  controllers: [AnalyticsController, ExportsController],
  providers: [ReportBuilder, ExportsService],
})
export class ReportsModule {}
