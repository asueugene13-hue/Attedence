import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApproveRescheduleSchema,
  IdSchema,
  RejectRescheduleSchema,
  RescheduleListQuerySchema,
  RescheduleProposalSchema,
  RescheduleRequestSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { RescheduleService } from './reschedule.service.js';

/**
 * Reschedules (D-11). Who may do what depends on the class (its lecturer, or an administrator whose
 * scope covers it), so routes open to both are checked in the service.
 */
@Controller()
export class RescheduleController {
  constructor(private readonly reschedules: RescheduleService) {}

  /** `{ date, startTime, endTime, classroomId }`: the conflict check, nothing saved. */
  @Post('class-sessions/:id/reschedule-check')
  @Authenticated()
  @HttpCode(200)
  check(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Body() body: unknown) {
    return this.reschedules.check(
      auth,
      parseInput(IdSchema, param),
      parseInput(RescheduleProposalSchema, body),
    );
  }

  /** The class's lecturer asks; `{ date, startTime, endTime, classroomId, reason }`. */
  @Post('class-sessions/:id/reschedule-requests')
  @RequirePermissions('class_sessions.request_reschedule')
  request(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reschedules.request(
      auth,
      parseInput(IdSchema, param),
      parseInput(RescheduleRequestSchema, body),
      requestContextOf(req),
    );
  }

  /** An administrator reschedules directly, in exceptional cases, with a reason. */
  @Post('class-sessions/:id/reschedule')
  @RequirePermissions('class_sessions.reschedule')
  direct(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reschedules.direct(
      auth,
      parseInput(IdSchema, param),
      parseInput(RescheduleRequestSchema, body),
      requestContextOf(req),
    );
  }

  /** `?status=`. Lecturers see their own requests; administrators those within their scope. */
  @Get('reschedule-requests')
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.reschedules.list(auth, parseInput(RescheduleListQuerySchema, query).status);
  }

  @Get('reschedule-requests/:id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.reschedules.get(auth, parseInput(IdSchema, param));
  }

  @Post('reschedule-requests/:id/approve')
  @RequirePermissions('class_sessions.reschedule')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { note } = parseInput(ApproveRescheduleSchema, body ?? {});
    return this.reschedules.approve(auth, parseInput(IdSchema, param), note, requestContextOf(req));
  }

  /** `{ note }`: why it was rejected. */
  @Post('reschedule-requests/:id/reject')
  @RequirePermissions('class_sessions.reschedule')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { note } = parseInput(RejectRescheduleSchema, body);
    return this.reschedules.reject(auth, parseInput(IdSchema, param), note, requestContextOf(req));
  }

  @Post('reschedule-requests/:id/withdraw')
  @RequirePermissions('class_sessions.request_reschedule')
  @HttpCode(200)
  withdraw(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.reschedules.withdraw(auth, parseInput(IdSchema, param), requestContextOf(req));
  }
}
