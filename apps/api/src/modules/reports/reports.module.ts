import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { AnalyticsController } from './analytics.controller.js';

/**
 * Reports and analytics (Phase 7). The numbers come from the modules that own the data (attendance,
 * class sessions), which work them out from their own tables within the caller's scope.
 */
@Module({
  imports: [AttendanceModule, AuthModule, ClassSessionsModule],
  controllers: [AnalyticsController],
})
export class ReportsModule {}
