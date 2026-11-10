import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { IdSchema, ReviewRiskFlagSchema, RiskFlagQuerySchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { RiskFlagsService } from './risk-flags.service.js';

@Controller('risk-flags')
export class RiskFlagsController {
  constructor(private readonly flags: RiskFlagsService) {}

  /** `?status=OPEN` (default) `|DISMISSED|CONFIRMED` and `&type=`. Open flags oldest first. */
  @Get()
  @RequirePermissions('risk_flags.review')
  list(@Query() query: unknown) {
    return this.flags.list(parseInput(RiskFlagQuerySchema, query));
  }

  /** `{ decision: CONFIRMED|DISMISSED, note }`. Nothing else changes: a person acts separately if needed. */
  @Post(':id/review')
  @RequirePermissions('risk_flags.review')
  @HttpCode(200)
  review(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { decision, note } = parseInput(ReviewRiskFlagSchema, body);
    return this.flags.review(auth, parseInput(IdSchema, param), decision, note, requestContextOf(req));
  }
}
