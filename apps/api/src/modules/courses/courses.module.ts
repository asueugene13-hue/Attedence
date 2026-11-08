import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';
import { LecturersService } from './lecturers.service.js';

@Module({
  imports: [AcademicModule, AuthModule],
  controllers: [CoursesController],
  providers: [CoursesService, LecturersService],
  exports: [CoursesService, LecturersService],
})
export class CoursesModule {}
