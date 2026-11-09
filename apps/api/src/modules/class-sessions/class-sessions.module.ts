import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { PlacesModule } from '../places/places.module.js';
import { StudentsModule } from '../students/students.module.js';
import { TimetablesModule } from '../timetables/timetables.module.js';
import { ClassSessionsController } from './class-sessions.controller.js';
import { ClassSessionsService } from './class-sessions.service.js';
import { SessionGenerationService } from './session-generation.service.js';

@Module({
  imports: [TimetablesModule, CoursesModule, PlacesModule, EnrollmentsModule, StudentsModule],
  controllers: [ClassSessionsController],
  providers: [ClassSessionsService, SessionGenerationService],
  exports: [ClassSessionsService, SessionGenerationService],
})
export class ClassSessionsModule {}
