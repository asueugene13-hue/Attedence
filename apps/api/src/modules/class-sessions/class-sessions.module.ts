import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { PlacesModule } from '../places/places.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StudentsModule } from '../students/students.module.js';
import { TimetablesModule } from '../timetables/timetables.module.js';
import { ClassEventService } from './class-event.service.js';
import { ClassMonitorService } from './class-monitor.service.js';
import { ClassReviewsController } from './class-reviews.controller.js';
import { ClassReviewsService } from './class-reviews.service.js';
import { ClassSessionsController } from './class-sessions.controller.js';
import { ClassSessionsService } from './class-sessions.service.js';
import { IssueReportsController } from './issue-reports.controller.js';
import { IssueReportsService } from './issue-reports.service.js';
import { RescheduleController } from './reschedule.controller.js';
import { RescheduleService } from './reschedule.service.js';
import { SessionGenerationService } from './session-generation.service.js';

@Module({
  imports: [
    AcademicModule,
    TimetablesModule,
    CoursesModule,
    PlacesModule,
    EnrollmentsModule,
    StudentsModule,
    SettingsModule,
  ],
  controllers: [
    ClassSessionsController,
    RescheduleController,
    IssueReportsController,
    ClassReviewsController,
  ],
  providers: [
    ClassSessionsService,
    SessionGenerationService,
    ClassEventService,
    RescheduleService,
    ClassMonitorService,
    IssueReportsService,
    ClassReviewsService,
  ],
  exports: [ClassSessionsService, SessionGenerationService, ClassEventService, ClassMonitorService],
})
export class ClassSessionsModule {}
