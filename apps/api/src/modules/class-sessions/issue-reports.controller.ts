import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IdSchema, IssueReportSchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { IssueReportsService } from './issue-reports.service.js';

/** Problems with a class, reported by its students, course rep and lecturer (CLASS_MONITORING.md §2). */
@Controller()
export class IssueReportsController {
  constructor(private readonly reports: IssueReportsService) {}

  /** `{ type, note? }`. Who may report, and when, is checked in the service. */
  @Post('class-sessions/:id/issue-reports')
  @RequirePermissions('class_issues.report')
  report(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reports.report(
      auth,
      parseInput(IdSchema, param),
      parseInput(IssueReportSchema, body),
      requestContextOf(req),
    );
  }

  /** All reports for the class's lecturer and administrators in scope; otherwise the caller's own. */
  @Get('class-sessions/:id/issue-reports')
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.reports.list(auth, parseInput(IdSchema, param));
  }
}
