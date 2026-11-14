import { Controller, Get } from '@nestjs/common';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { DashboardsService } from './dashboards.service.js';

@Controller()
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  /** For administrators: today's classes, the last 7 days' attendance and what waits, within scope. */
  @Get('me/admin-dashboard')
  @Authenticated()
  admin(@CurrentAuth() auth: AccessClaims) {
    return this.dashboards.admin(auth);
  }

  /** For lecturers: `{ waiting, excusedThisWeek, sections, minimumPercent }`. */
  @Get('me/lecturer-dashboard')
  @Authenticated()
  lecturer(@CurrentAuth() auth: AccessClaims) {
    return this.dashboards.lecturer(auth);
  }
}
