import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { FilesModule } from '../files/files.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { DisputesController } from './disputes.controller.js';
import { DisputesService } from './disputes.service.js';
import { ExcusesController } from './excuses.controller.js';
import { ExcusesService } from './excuses.service.js';

/**
 * Requests from students (Phase 6): attendance disputes (step 2) and excuse requests (step 3). Owns
 * the dispute and excuse tables. Records change only through the attendance module's AttendanceRecordsService.
 */
@Module({
  imports: [
    AcademicModule,
    AttendanceModule,
    AuthModule,
    ClassSessionsModule,
    CoursesModule,
    EnrollmentsModule,
    FilesModule,
    NotificationsModule,
    SettingsModule,
    StudentsModule,
  ],
  controllers: [DisputesController, ExcusesController],
  providers: [DisputesService, ExcusesService],
})
export class RequestsModule {}
