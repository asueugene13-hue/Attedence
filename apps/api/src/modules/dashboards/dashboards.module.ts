import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { BeaconsModule } from '../beacons/beacons.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { RiskFlagsModule } from '../risk-flags/risk-flags.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DashboardsController } from './dashboards.controller.js';
import { DashboardsService } from './dashboards.service.js';

/** Dashboards (Phase 6 step 6). Owns no tables: it asks the modules that own the data. */
@Module({
  imports: [
    AttendanceModule,
    AuthModule,
    BeaconsModule,
    ClassSessionsModule,
    CoursesModule,
    DevicesModule,
    RequestsModule,
    RiskFlagsModule,
    SettingsModule,
  ],
  controllers: [DashboardsController],
  providers: [DashboardsService],
})
export class DashboardsModule {}
