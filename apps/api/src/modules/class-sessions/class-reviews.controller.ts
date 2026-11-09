import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { DecideReviewSchema, DismissReportSchema, IdSchema, ReviewListQuerySchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { ClassReviewsService } from './class-reviews.service.js';
import { IssueReportsService } from './issue-reports.service.js';

/** The review queue and decisions (CLASS_MONITORING.md §7); administrators within their scope. */
@Controller()
export class ClassReviewsController {
  constructor(
    private readonly reviews: ClassReviewsService,
    private readonly reports: IssueReportsService,
  ) {}

  /** `?status=OPEN` (default) or `DECIDED`. Open reviews: priority first, then the oldest. */
  @Get('class-reviews')
  @RequirePermissions('class_reviews.decide')
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.reviews.list(auth, parseInput(ReviewListQuerySchema, query).status);
  }

  @Get('class-reviews/:id')
  @RequirePermissions('class_reviews.decide')
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.reviews.get(auth, parseInput(IdSchema, param));
  }

  /** `{ decision, note, … }`: CLASS_HELD, NO_ACTION, CANCELLED (+ reasonCode), POSTPONED (+ minutes), RESCHEDULED (+ reschedule). */
  @Post('class-reviews/:id/decide')
  @RequirePermissions('class_reviews.decide')
  @HttpCode(200)
  decide(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reviews.decide(
      auth,
      parseInput(IdSchema, param),
      parseInput(DecideReviewSchema, body),
      requestContextOf(req),
    );
  }

  /** `{ note }`: a report that proved wrong stops counting as evidence. */
  @Post('class-issue-reports/:id/dismiss')
  @RequirePermissions('class_reviews.decide')
  @HttpCode(200)
  dismiss(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { note } = parseInput(DismissReportSchema, body);
    return this.reports.dismiss(auth, parseInput(IdSchema, param), note, requestContextOf(req));
  }
}
