import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { FilesModule } from '../files/files.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { DisputesController } from './disputes.controller.js';
import { DisputesService } from './disputes.service.js';

/**
 * Requests from students (Phase 6): attendance disputes (step 2), excuse requests next. Owns the
 * dispute tables. Records change only through the attendance module's AttendanceRecordsService.
 */
@Module({
  imports: [
    AttendanceModule,
    AuthModule,
    ClassSessionsModule,
    CoursesModule,
    FilesModule,
    NotificationsModule,
    SettingsModule,
    StudentsModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService],
})
export class RequestsModule {}
