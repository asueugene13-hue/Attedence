import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  CorrectionRequestQuerySchema,
  CorrectRecordSchema,
  DecideCorrectionRequestSchema,
  IdSchema,
} from '@attendsure/shared';
import type { Request, Response } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { CorrectionsService } from './corrections.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** Correcting attendance records (ATTENDANCE_FLOW §7). */
@Controller()
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  /**
   * `{ status: PRESENT | LATE | ABSENT | REJECTED, reason, version }`. 200 when applied; 202 when it
   * becomes a request for an administrator (a lecturer after the correction window).
   */
  @Post('attendance-records/:id/correct')
  @RequirePermissions('attendance.correct')
  async correct(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.corrections.correct(
      auth,
      id(param),
      parseInput(CorrectRecordSchema, body),
      requestContextOf(req),
    );
    res.status(result.applied ? 200 : 202);
    return result;
  }

  /** Every change to a record, with the check-ins and decisions behind it. */
  @Get('attendance-records/:id/history')
  @Authenticated()
  history(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.corrections.history(auth, id(param));
  }

  /** `?status=PENDING` (default): late corrections waiting for an administrator in scope. */
  @Get('attendance-correction-requests')
  @RequirePermissions('attendance.correct')
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.corrections.listRequests(auth, parseInput(CorrectionRequestQuerySchema, query).status);
  }

  /** `{ decision: APPROVE | REJECT, note? (required to reject) }`. */
  @Post('attendance-correction-requests/:id/decide')
  @RequirePermissions('attendance.correct')
  @HttpCode(200)
  decide(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.corrections.decideRequest(
      auth,
      id(param),
      parseInput(DecideCorrectionRequestSchema, body),
      requestContextOf(req),
    );
  }
}
