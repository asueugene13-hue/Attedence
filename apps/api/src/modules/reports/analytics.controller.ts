import { Controller, Get, Query } from '@nestjs/common';
import { AttendanceAnalyticsQuerySchema, ClassAnalyticsQuerySchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import { AttendanceAnalyticsService } from '../attendance/attendance-analytics.service.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { ClassAnalyticsService } from '../class-sessions/class-analytics.service.js';

/** Analytics for administrators (Phase 7 step 1), within their scope. */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly attendance: AttendanceAnalyticsService,
    private readonly classes: ClassAnalyticsService,
  ) {}

  /** `?semesterId=&groupBy=faculty|department|programme|level|course|lecturer` (default: active semester, department). */
  @Get('attendance')
  @RequirePermissions('analytics.read')
  attendanceAnalytics(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    const q = parseInput(AttendanceAnalyticsQuerySchema, query);
    return this.attendance.attendance(auth, q.semesterId, q.groupBy);
  }

  /** `?semesterId=&groupBy=faculty|department|course|lecturer`. */
  @Get('classes')
  @RequirePermissions('analytics.read')
  classAnalytics(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    const q = parseInput(ClassAnalyticsQuerySchema, query);
    return this.classes.classes(auth, q.semesterId, q.groupBy);
  }
}
