import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateTimetableSchema,
  EntryExceptionSchema,
  IdSchema,
  PublishTimetableSchema,
  ReasonOnlySchema,
  TimetableEntrySchema,
  TimetableQuerySchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { TimetablesService } from './timetables.service.js';

const id = (value: string) => parseInput(IdSchema, value);

function expectedVersion(req: Request): number {
  const header = req.headers['if-match'];
  const value = typeof header === 'string' ? Number(header.replace(/"/g, '')) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException({
      code: 'VERSION_REQUIRED',
      message: 'Send the If-Match header with the entry version you are changing.',
    });
  }
  return value;
}

@Controller()
export class TimetablesController {
  constructor(private readonly timetables: TimetablesService) {}

  @Get('timetables')
  @RequirePermissions('timetables.read')
  list(@Query() query: unknown) {
    return this.timetables.list(parseInput(TimetableQuerySchema, query));
  }

  @Post('timetables')
  @RequirePermissions('timetables.manage')
  create(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.timetables.create(auth, parseInput(CreateTimetableSchema, body), requestContextOf(req));
  }

  @Get('timetables/:id')
  @RequirePermissions('timetables.read')
  get(@Param('id') param: string) {
    return this.timetables.get(id(param));
  }

  @Get('timetables/:id/conflicts')
  @RequirePermissions('timetables.manage')
  conflicts(@Param('id') param: string) {
    return this.timetables.conflicts(id(param));
  }

  @Post('timetables/:id/publish')
  @RequirePermissions('timetables.publish')
  @HttpCode(200)
  publish(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(PublishTimetableSchema, body ?? {});
    return this.timetables.publish(auth, id(param), reason, requestContextOf(req));
  }

  @Get('timetables/:id/history')
  @RequirePermissions('timetables.manage')
  history(@Param('id') param: string) {
    return this.timetables.history(id(param));
  }

  @Post('timetables/:id/entries')
  @RequirePermissions('timetables.manage')
  addEntry(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.timetables.addEntry(
      auth,
      id(param),
      parseInput(TimetableEntrySchema, body),
      requestContextOf(req),
    );
  }

  @Patch('timetable-entries/:id')
  @RequirePermissions('timetables.manage')
  updateEntry(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const entryId = id(param);
    const version = expectedVersion(req);
    return this.timetables.updateEntry(
      auth,
      entryId,
      version,
      parseInput(TimetableEntrySchema, body),
      requestContextOf(req),
    );
  }

  @Post('timetable-entries/:id/cancel')
  @RequirePermissions('timetables.manage')
  @HttpCode(200)
  cancelEntry(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.timetables.cancelEntry(
      auth,
      id(param),
      parseInput(ReasonOnlySchema, body).reason,
      requestContextOf(req),
    );
  }

  /** The dates this entry meets on, and the dates skipped (holidays, exceptions) with why. */
  @Get('timetable-entries/:id/dates')
  @RequirePermissions('timetables.read')
  dates(@Param('id') param: string) {
    return this.timetables.entryDates(id(param));
  }

  @Post('timetable-entries/:id/exceptions')
  @RequirePermissions('timetables.manage')
  addException(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.timetables.addException(
      auth,
      id(param),
      parseInput(EntryExceptionSchema, body),
      requestContextOf(req),
    );
  }

  @Post('timetable-entries/:id/exceptions/:exceptionId/remove')
  @RequirePermissions('timetables.manage')
  @HttpCode(200)
  removeException(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Param('exceptionId') exceptionParam: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.timetables.removeException(
      auth,
      id(param),
      id(exceptionParam),
      reason,
      requestContextOf(req),
    );
  }
}
