import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { StudentsController } from './students.controller.js';
import { StudentImportService } from './student-import.service.js';
import { StudentsService } from './students.service.js';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [StudentsController],
  providers: [StudentsService, StudentImportService],
  exports: [StudentsService, StudentImportService],
})
export class StudentsModule {}
