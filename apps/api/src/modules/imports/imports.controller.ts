import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
} from '@nestjs/common';
import {
  IdSchema,
  IMPORT_LIMITS,
  IMPORT_TYPES,
  ImportFormatQuerySchema,
  ImportListQuerySchema,
  ImportRowsQuerySchema,
} from '@attendsure/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContextOf } from '../../common/request-context.js';
import { requireFile, SingleFileUpload, type UploadedBytes } from '../../common/upload.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { ImportsService } from './imports.service.js';
import { SHEET_MIME, type SheetFormat } from './spreadsheet.js';

const id = (value: string) => parseInput(IdSchema, value);
const TemplateTypeSchema = z.enum(IMPORT_TYPES.map((t) => t.toLowerCase()) as ['students']);

function download(res: Response, bytes: Buffer, name: string, format: SheetFormat) {
  res.setHeader('Content-Type', SHEET_MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(bytes);
}

/** Bulk student import. Only STUDENTS imports exist so far; enrolment imports come with step 6. */
@Controller('imports')
@RequirePermissions('students.import')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('templates/:type')
  async template(
    @Param('type') type: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const kind = parseInput(TemplateTypeSchema, type);
    const { format } = parseInput(ImportFormatQuerySchema, query);
    return download(res, await this.imports.template(format), `${kind}-import-template`, format);
  }

  /** Multipart upload, field `file`: CSV or .xlsx, up to 5 MB and 5,000 rows. Returns the checked preview. */
  @Post()
  @SingleFileUpload('file', IMPORT_LIMITS.maxFileBytes)
  upload(
    @CurrentAuth() auth: AccessClaims,
    @UploadedFile() file: UploadedBytes | undefined,
    @Req() req: Request,
  ) {
    return this.imports.upload(auth, requireFile(file, 'file'), requestContextOf(req));
  }

  @Get()
  list(@Query() query: unknown) {
    return this.imports.list(parseInput(ImportListQuerySchema, query));
  }

  @Get(':id')
  get(@Param('id') param: string) {
    return this.imports.get(id(param));
  }

  @Get(':id/rows')
  rows(@Param('id') param: string, @Query() query: unknown) {
    return this.imports.rows(id(param), parseInput(ImportRowsQuerySchema, query));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.imports.confirm(auth, id(param), requestContextOf(req));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.imports.cancel(auth, id(param), requestContextOf(req));
  }

  @Post(':id/activation-emails')
  @HttpCode(200)
  retryEmails(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.imports.retryActivationEmails(auth, id(param), requestContextOf(req));
  }

  @Get(':id/error-report')
  async errorReport(
    @Param('id') param: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const batchId = id(param);
    const { format } = parseInput(ImportFormatQuerySchema, query);
    return download(
      res,
      await this.imports.errorReport(batchId, format),
      `import-${batchId}-problems`,
      format,
    );
  }
}
