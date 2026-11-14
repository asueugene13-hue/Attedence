import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile } from '@nestjs/common';
import {
  ApproveExcuseSchema,
  ExcuseListQuerySchema,
  ExcuseQuestionSchema,
  ExcuseReplySchema,
  IdSchema,
  RejectExcuseSchema,
  REQUEST_ATTACHMENT_LIMITS,
  SubmitExcuseSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { requireFile, SingleFileUpload, type UploadedBytes } from '../../common/upload.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { ExcusesService } from './excuses.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/**
 * Excuse requests (ATTENDANCE_FLOW §7, D-22). Students send them; only administrators in scope see and
 * decide them (lecturers are refused, even though they hold `requests.review` for disputes).
 */
@Controller('excuse-requests')
export class ExcusesController {
  constructor(private readonly excuses: ExcusesService) {}

  /** `{ category, startDate, endDate, description, classSessionIds? }`. */
  @Post()
  @RequirePermissions('requests.submit')
  submit(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.excuses.submit(auth, parseInput(SubmitExcuseSchema, body), requestContextOf(req));
  }

  /** `?state=OPEN|DECIDED|ALL`: a student's own, or those an administrator may decide. */
  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.excuses.list(auth, parseInput(ExcuseListQuerySchema, query).state);
  }

  @Get(':id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.excuses.get(auth, id(param));
  }

  /** Multipart, field `file`: a PDF, JPEG or PNG up to 10 MB; at most 3 per request. */
  @Post(':id/attachments')
  @RequirePermissions('requests.submit')
  @SingleFileUpload('file', REQUEST_ATTACHMENT_LIMITS.maxFileBytes)
  attach(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @UploadedFile() file: UploadedBytes | undefined,
    @Req() req: Request,
  ) {
    return this.excuses.attach(auth, id(param), requireFile(file, 'file'), requestContextOf(req));
  }

  @Get(':id/attachments/:fileId')
  @Authenticated()
  attachment(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Param('fileId') file: string) {
    return this.excuses.attachmentLink(auth, id(param), id(file));
  }

  @Post(':id/request-info')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  ask(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { question } = parseInput(ExcuseQuestionSchema, body);
    return this.excuses.ask(auth, id(param), question, requestContextOf(req));
  }

  @Post(':id/respond')
  @RequirePermissions('requests.submit')
  @HttpCode(200)
  respond(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reply } = parseInput(ExcuseReplySchema, body);
    return this.excuses.reply(auth, id(param), reply, requestContextOf(req));
  }

  /** `{ classSessionIds, note? }`: excuse those classes (a subset of the ones covered). */
  @Post(':id/approve')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.excuses.approve(
      auth,
      id(param),
      parseInput(ApproveExcuseSchema, body),
      requestContextOf(req),
    );
  }

  @Post(':id/reject')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.excuses.reject(auth, id(param), parseInput(RejectExcuseSchema, body), requestContextOf(req));
  }

  @Post(':id/withdraw')
  @RequirePermissions('requests.submit')
  @HttpCode(200)
  withdraw(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.excuses.withdraw(auth, id(param), requestContextOf(req));
  }
}
