import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
} from '@nestjs/common';
import {
  CreateStudentSchema,
  IdSchema,
  PHOTO_LIMITS,
  ReasonOnlySchema,
  StudentQuerySchema,
  StudentStatusChangeSchema,
  UpdateStudentSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { requireFile, SingleFileUpload, type UploadedBytes } from '../../common/upload.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { StudentsService } from './students.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/**
 * Changes to an existing record must say which version they were based on, in the If-Match header
 * (the `version` returned with the record). A stale version gets 409 instead of overwriting.
 */
function expectedVersion(req: Request): number {
  const header = req.headers['if-match'];
  const value = typeof header === 'string' ? Number(header.replace(/"/g, '')) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException({
      code: 'VERSION_REQUIRED',
      message: 'Send the If-Match header with the record version you are changing.',
    });
  }
  return value;
}

@Controller()
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get('students')
  @RequirePermissions('students.read_full')
  list(@Query() query: unknown) {
    return this.students.list(parseInput(StudentQuerySchema, query));
  }

  @Post('students')
  @RequirePermissions('students.create')
  create(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.students.create(auth, parseInput(CreateStudentSchema, body), requestContextOf(req));
  }

  @Get('students/:id')
  @RequirePermissions('students.read_full')
  get(@Param('id') param: string) {
    return this.students.get(id(param));
  }

  @Patch('students/:id')
  @RequirePermissions('students.update')
  update(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.students.update(
      auth,
      id(param),
      expectedVersion(req),
      parseInput(UpdateStudentSchema, body),
      requestContextOf(req),
    );
  }

  @Post('students/:id/status')
  @RequirePermissions('students.update')
  @HttpCode(200)
  changeStatus(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const input = parseInput(StudentStatusChangeSchema, body);
    return this.students.changeStatus(
      auth,
      id(param),
      expectedVersion(req),
      input.status,
      input.reason,
      requestContextOf(req),
    );
  }

  @Post('students/:id/verify')
  @RequirePermissions('students.update')
  @HttpCode(200)
  verify(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.students.verify(auth, id(param), expectedVersion(req), requestContextOf(req));
  }

  /** Multipart upload, field `photo`: a JPEG or PNG up to 2 MB. Needs If-Match like any other change. */
  @Post('students/:id/photo')
  @RequirePermissions('students.update')
  @HttpCode(200)
  @SingleFileUpload('photo', PHOTO_LIMITS.maxFileBytes)
  setPhoto(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @UploadedFile() file: UploadedBytes | undefined,
    @Req() req: Request,
  ) {
    const studentId = id(param);
    const version = expectedVersion(req);
    return this.students.setPhoto(
      auth,
      studentId,
      version,
      requireFile(file, 'photo'),
      requestContextOf(req),
    );
  }

  @Delete('students/:id/photo')
  @RequirePermissions('students.update')
  removePhoto(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.students.removePhoto(auth, id(param), expectedVersion(req), reason, requestContextOf(req));
  }

  /** A download link that works for 5 minutes. */
  @Get('students/:id/photo')
  @RequirePermissions('students.read_full')
  photo(@Param('id') param: string) {
    return this.students.photoLink({ id: id(param) });
  }

  @Get('me/student/photo')
  @Authenticated()
  myPhoto(@CurrentAuth() auth: AccessClaims) {
    return this.students.photoLink({ userId: auth.userId });
  }

  /** The signed-in student's own record (null for anyone who is not a student). */
  @Get('me/student')
  @Authenticated()
  async mine(@CurrentAuth() auth: AccessClaims) {
    return { student: await this.students.mine(auth.userId) };
  }
}
