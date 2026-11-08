import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { StudentsModule } from '../students/students.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [FilesModule, StudentsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
