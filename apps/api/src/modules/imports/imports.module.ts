import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { FilesModule } from '../files/files.module.js';
import { StudentsModule } from '../students/students.module.js';
import { EnrollmentImportsController, StudentImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [FilesModule, StudentsModule, EnrollmentsModule],
  controllers: [StudentImportsController, EnrollmentImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
