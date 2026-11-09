import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { PlacesModule } from '../places/places.module.js';
import { StudentsModule } from '../students/students.module.js';
import { TimetablesController } from './timetables.controller.js';
import { TimetablesService } from './timetables.service.js';

@Module({
  imports: [AcademicModule, CoursesModule, PlacesModule, EnrollmentsModule, StudentsModule],
  controllers: [TimetablesController],
  providers: [TimetablesService],
  exports: [TimetablesService],
})
export class TimetablesModule {}
