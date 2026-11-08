import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  type Type,
  UploadedFile,
} from '@nestjs/common';
import {
  IdSchema,
  IMPORT_LIMITS,
  ImportFormatQuerySchema,
  ImportListQuerySchema,
  ImportRowsQuerySchema,
  type PermissionKey,
} from '@attendsure/shared';
import type { Request, Response } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { requireFile, SingleFileUpload, type UploadedBytes } from '../../common/upload.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { EnrollmentImportService } from '../enrollments/enrollment-import.service.js';
import { StudentImportService } from '../students/student-import.service.js';
import type { ImportHandler } from './import-handler.js';
import { ImportsService } from './imports.service.js';
import { SHEET_MIME, type SheetFormat } from './spreadsheet.js';

const id = (value: string) => parseInput(IdSchema, value);

function download(res: Response, bytes: Buffer, name: string, format: SheetFormat) {
  res.setHeader('Content-Type', SHEET_MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(bytes);
}

/**
 * Builds the routes for one import type under /imports/<slug>, guarded by that type's permission.
 * The same pipeline serves every type; the URL decides which handler (and permission) applies.
 */
function importController(
  slug: string,
  permission: PermissionKey,
  handlerClass: Type<ImportHandler>,
  className: string,
  options: { activationEmails: boolean },
): Type<unknown> {
  @Controller(`imports/${slug}`)
  @RequirePermissions(permission)
  class TypedImportsController {
    constructor(
      @Inject(ImportsService) private readonly imports: ImportsService,
      @Inject(handlerClass) private readonly handler: ImportHandler,
    ) {}

    @Get('template')
    async template(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
      const { format } = parseInput(ImportFormatQuerySchema, query);
      return download(
        res,
        await this.imports.template(this.handler, format),
        `${slug}-import-template`,
        format,
      );
    }

    /** Multipart upload, field `file`: CSV or .xlsx, up to 5 MB and 5,000 rows. Returns the checked preview. */
    @Post()
    @SingleFileUpload('file', IMPORT_LIMITS.maxFileBytes)
    upload(
      @CurrentAuth() auth: AccessClaims,
      @UploadedFile() file: UploadedBytes | undefined,
      @Req() req: Request,
    ) {
      return this.imports.upload(this.handler, auth, requireFile(file, 'file'), requestContextOf(req));
    }

    @Get()
    list(@Query() query: unknown) {
      return this.imports.list(this.handler, parseInput(ImportListQuerySchema, query));
    }

    @Get(':id')
    get(@Param('id') param: string) {
      return this.imports.get(this.handler, id(param));
    }

    @Get(':id/rows')
    rows(@Param('id') param: string, @Query() query: unknown) {
      return this.imports.rows(this.handler, id(param), parseInput(ImportRowsQuerySchema, query));
    }

    @Post(':id/confirm')
    @HttpCode(200)
    confirm(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
      return this.imports.confirm(this.handler, auth, id(param), requestContextOf(req));
    }

    @Post(':id/cancel')
    @HttpCode(200)
    cancel(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
      return this.imports.cancel(this.handler, auth, id(param), requestContextOf(req));
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
        await this.imports.errorReport(this.handler, batchId, format),
        `import-${batchId}-problems`,
        format,
      );
    }

    /** Re-sends failed activation emails. Routed only for imports that create accounts (below). */
    retryEmails(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
      return this.imports.retryActivationEmails(this.handler, auth, id(param), requestContextOf(req));
    }
  }
  if (options.activationEmails) {
    const proto = TypedImportsController.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'retryEmails')!;
    HttpCode(200)(proto, 'retryEmails', descriptor);
    Post(':id/activation-emails')(proto, 'retryEmails', descriptor);
  }
  Object.defineProperty(TypedImportsController, 'name', { value: className });
  return TypedImportsController;
}

export const StudentImportsController = importController(
  'students',
  'students.import',
  StudentImportService,
  'StudentImportsController',
  { activationEmails: true },
);
export const EnrollmentImportsController = importController(
  'enrollments',
  'enrollments.manage',
  EnrollmentImportService,
  'EnrollmentImportsController',
  { activationEmails: false },
);
