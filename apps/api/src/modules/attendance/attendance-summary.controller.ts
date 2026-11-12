import { Controller, Get, Param } from '@nestjs/common';
import { IdSchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { AttendanceSummaryService } from './attendance-summary.service.js';

/** Attendance history and percentages (ATTENDANCE_FLOW §9). */
@Controller()
export class AttendanceSummaryController {
  constructor(private readonly summaries: AttendanceSummaryService) {}

  /** The signed-in student's courses with their attendance. */
  @Get('me/attendance')
  @RequirePermissions('attendance.read_own')
  mine(@CurrentAuth() auth: AccessClaims) {
    return this.summaries.mine(auth);
  }

  /** Attendance open now for the student's classes, with their own status in each. */
  @Get('me/open-attendance')
  @RequirePermissions('attendance.read_own')
  open(@CurrentAuth() auth: AccessClaims) {
    return this.summaries.openForMe(auth);
  }

  /** One course, class by class: counted or not, and why. */
  @Get('me/attendance/offerings/:id')
  @RequirePermissions('attendance.read_own')
  mineForOffering(@CurrentAuth() auth: AccessClaims, @Param('id') id: string) {
    return this.summaries.mineForOffering(auth, parseInput(IdSchema, id));
  }

  /** A section's students with their attendance (its lecturers; administrators in scope). */
  @Get('course-sections/:id/attendance-summary')
  @Authenticated()
  section(@CurrentAuth() auth: AccessClaims, @Param('id') id: string) {
    return this.summaries.section(auth, parseInput(IdSchema, id));
  }
}
