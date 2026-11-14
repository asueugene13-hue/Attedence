import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StudentsModule } from '../students/students.module.js';
import { StudentIdsController } from './student-ids.controller.js';
import { StudentIdsService } from './student-ids.service.js';

/** The digital student ID (Phase 6 step 5). Owns no tables: codes live briefly in Redis. */
@Module({
  imports: [AuthModule, StudentsModule],
  controllers: [StudentIdsController],
  providers: [StudentIdsService],
})
export class StudentIdsModule {}
