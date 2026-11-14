import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile } from '@nestjs/common';
import {
  ApproveDisputeSchema,
  DisputeListQuerySchema,
  DisputeQuestionSchema,
  DisputeReplySchema,
  IdSchema,
  RejectDisputeSchema,
  REQUEST_ATTACHMENT_LIMITS,
  SubmitDisputeSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { requireFile, SingleFileUpload, type UploadedBytes } from '../../common/upload.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { DisputesService } from './disputes.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** Attendance disputes (ATTENDANCE_FLOW §7, D-21). Who may see each one is checked in the service. */
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /** A student disputes their own record for a class: `{ classSessionId, reason }`. */
  @Post()
  @RequirePermissions('requests.submit')
  submit(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.disputes.submit(auth, parseInput(SubmitDisputeSchema, body), requestContextOf(req));
  }

  /** `?state=OPEN|DECIDED|ALL`: a student's own, or the ones the caller may review. */
  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.disputes.list(auth, parseInput(DisputeListQuerySchema, query).state);
  }

  @Get(':id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.disputes.get(auth, id(param));
  }

  /** Multipart, field `file`: a PDF, JPEG or PNG up to 10 MB; at most 3 per dispute. */
  @Post(':id/attachments')
  @RequirePermissions('requests.submit')
  @SingleFileUpload('file', REQUEST_ATTACHMENT_LIMITS.maxFileBytes)
  attach(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @UploadedFile() file: UploadedBytes | undefined,
    @Req() req: Request,
  ) {
    return this.disputes.attach(auth, id(param), requireFile(file, 'file'), requestContextOf(req));
  }

  /** A short-lived download link for an attached file. */
  @Get(':id/attachments/:fileId')
  @Authenticated()
  attachment(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Param('fileId') file: string) {
    return this.disputes.attachmentLink(auth, id(param), id(file));
  }

  /** The reviewer asks the student something: `{ question }`. */
  @Post(':id/request-info')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  ask(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { question } = parseInput(DisputeQuestionSchema, body);
    return this.disputes.ask(auth, id(param), question, requestContextOf(req));
  }

  /** The student answers: `{ reply }`. */
  @Post(':id/respond')
  @RequirePermissions('requests.submit')
  @HttpCode(200)
  respond(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reply } = parseInput(DisputeReplySchema, body);
    return this.disputes.reply(auth, id(param), reply, requestContextOf(req));
  }

  /** `{ status: PRESENT | LATE, note? }`: the record changes, with a correction and an audit entry. */
  @Post(':id/approve')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.disputes.approve(
      auth,
      id(param),
      parseInput(ApproveDisputeSchema, body),
      requestContextOf(req),
    );
  }

  /** `{ note }` (required): the record stays as it is. */
  @Post(':id/reject')
  @RequirePermissions('requests.review')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.disputes.reject(
      auth,
      id(param),
      parseInput(RejectDisputeSchema, body),
      requestContextOf(req),
    );
  }

  @Post(':id/withdraw')
  @RequirePermissions('requests.submit')
  @HttpCode(200)
  withdraw(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.disputes.withdraw(auth, id(param), requestContextOf(req));
  }
}
