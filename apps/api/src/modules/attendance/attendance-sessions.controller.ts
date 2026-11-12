import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  CloseAttendanceSchema,
  ExtendAttendanceSchema,
  IdSchema,
  OpenAttendanceSchema,
  ReopenAttendanceSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** Opening and running attendance for a class (ATTENDANCE_FLOW.md §1, §5). */
@Controller()
export class AttendanceSessionsController {
  constructor(private readonly sessions: AttendanceSessionsService) {}

  /** The class's own lecturer: `{ startClass = true, lateAfterMinutes?, closeAfterMinutes? }`. */
  @Post('class-sessions/:id/attendance/open')
  @RequirePermissions('attendance.open')
  open(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.sessions.open(
      auth,
      id(param),
      parseInput(OpenAttendanceSchema, body ?? {}),
      requestContextOf(req),
    );
  }

  /** The attendance session of a class, or `null` if attendance was never opened. */
  @Get('class-sessions/:id/attendance')
  @Authenticated()
  async forClass(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return { data: await this.sessions.forClass(auth, id(param)) };
  }

  @Get('attendance-sessions/:id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.sessions.get(auth, id(param));
  }

  /** The current QR token for the lecturer's screen. */
  @Get('attendance-sessions/:id/qr')
  @RequirePermissions('attendance.open')
  qr(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.sessions.currentQr(auth, id(param));
  }

  /** The lecturer closes early; an administrator force-closes with `{ reason }`. */
  @Post('attendance-sessions/:id/close')
  @Authenticated()
  @HttpCode(200)
  close(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(CloseAttendanceSchema, body ?? {});
    return this.sessions.close(auth, id(param), reason, requestContextOf(req));
  }

  /** `{ minutes, reason }`. */
  @Post('attendance-sessions/:id/extend')
  @RequirePermissions('attendance.open')
  @HttpCode(200)
  extend(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const input = parseInput(ExtendAttendanceSchema, body);
    return this.sessions.extend(auth, id(param), input.minutes, input.reason, requestContextOf(req));
  }

  /** `{ reason, minutes = 10 }`, once, before the scheduled end. */
  @Post('attendance-sessions/:id/reopen')
  @RequirePermissions('attendance.open')
  @HttpCode(200)
  reopen(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const input = parseInput(ReopenAttendanceSchema, body);
    return this.sessions.reopen(auth, id(param), input.minutes, input.reason, requestContextOf(req));
  }
}
