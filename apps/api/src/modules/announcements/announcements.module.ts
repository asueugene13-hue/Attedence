import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { AnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';

/** Announcements (Phase 6 step 4). Owns the announcement tables. */
@Module({
  imports: [
    AcademicModule,
    AuthModule,
    CoursesModule,
    EnrollmentsModule,
    NotificationsModule,
    SettingsModule,
    StudentsModule,
  ],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
