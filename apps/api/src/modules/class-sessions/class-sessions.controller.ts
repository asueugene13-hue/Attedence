import { Controller, Get, Param, Query } from '@nestjs/common';
import { ClassSessionQuerySchema, IdSchema, MyTimetableQuerySchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { ClassSessionsService } from './class-sessions.service.js';

@Controller()
export class ClassSessionsController {
  constructor(private readonly sessions: ClassSessionsService) {}

  /** `?from=&to=` (local dates, at most 62 days) and optional section, lecturer, room or status. */
  @Get('class-sessions')
  @RequirePermissions('timetables.read')
  list(@Query() query: unknown) {
    return this.sessions.list(parseInput(ClassSessionQuerySchema, query));
  }

  /** One session with its full history of events. */
  @Get('class-sessions/:id')
  @RequirePermissions('timetables.read')
  get(@Param('id') param: string) {
    return this.sessions.get(parseInput(IdSchema, param));
  }

  /** The caller's own classes: as a lecturer, the ones they teach; as a student, their sections'. */
  @Get('me/timetable')
  @Authenticated()
  mine(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    const { from, to } = parseInput(MyTimetableQuerySchema, query);
    return this.sessions.mine(auth, from, to);
  }
}
