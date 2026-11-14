import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { IdSchema, RequestExportSchema } from '@attendsure/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { ExportsService } from './exports.service.js';

const id = (value: string) => parseInput(IdSchema, value);
const ListQuery = z.strictObject({ view: z.enum(['MINE', 'ALL']).default('MINE') });

/** Report files (Phase 7 step 2). The permissions each report needs are checked in the service. */
@Controller('reports/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  /** `{ reportType, format: CSV | XLSX | PDF, params }`: queued; 201 with the export (status QUEUED). */
  @Post()
  @Authenticated()
  request(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.exports.request(auth, parseInput(RequestExportSchema, body), requestContextOf(req));
  }

  /** `?view=MINE` (default), or `ALL` (the export log) for people who read the audit log. */
  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.exports.list(auth, parseInput(ListQuery, query).view === 'ALL');
  }

  @Get(':id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.exports.get(auth, id(param));
  }

  /** A short-lived download link (logged). `410 EXPIRED` after the retention period. */
  @Get(':id/download')
  @Authenticated()
  download(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.exports.download(auth, id(param), requestContextOf(req));
  }
}
