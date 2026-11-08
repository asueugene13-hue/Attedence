import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { UsersModule } from '../users/users.module.js';
import { StudentsController } from './students.controller.js';
import { StudentImportService } from './student-import.service.js';
import { StudentsService } from './students.service.js';

@Module({
  imports: [AuthModule, FilesModule, UsersModule, AcademicModule],
  controllers: [StudentsController],
  providers: [StudentsService, StudentImportService],
  exports: [StudentsService, StudentImportService],
})
export class StudentsModule {}
