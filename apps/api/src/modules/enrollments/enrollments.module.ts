import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { StudentsModule } from '../students/students.module.js';
import { CourseRepsService } from './course-reps.service.js';
import { EnrollmentImportService } from './enrollment-import.service.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';

@Module({
  imports: [AcademicModule, CoursesModule, StudentsModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService, CourseRepsService, EnrollmentImportService],
  exports: [EnrollmentsService, EnrollmentImportService, CourseRepsService],
})
export class EnrollmentsModule {}
