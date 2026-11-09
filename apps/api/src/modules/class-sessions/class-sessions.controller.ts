import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CancelClassSchema,
  type ClassActionName,
  ClassReasonSchema,
  ClassSessionQuerySchema,
  DelayClassSchema,
  IdSchema,
  MyTimetableQuerySchema,
  VoidClassSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { type ActionInput, ClassEventService } from './class-event.service.js';
import { ClassMonitorService } from './class-monitor.service.js';
import { ClassSessionsService } from './class-sessions.service.js';

@Controller()
export class ClassSessionsController {
  constructor(
    private readonly sessions: ClassSessionsService,
    private readonly events: ClassEventService,
    private readonly monitor: ClassMonitorService,
  ) {}

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

  // ── Lifecycle actions (CLASS_LIFECYCLE.md §4). Each returns the session as it is now. ──

  @Post('class-sessions/:id/confirm')
  @RequirePermissions('class_sessions.start')
  @HttpCode(200)
  confirm(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.run(auth, param, 'confirm', {}, req);
  }

  @Post('class-sessions/:id/start')
  @RequirePermissions('class_sessions.start')
  @HttpCode(200)
  start(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.run(auth, param, 'start', {}, req);
  }

  @Post('class-sessions/:id/resume')
  @RequirePermissions('class_sessions.start')
  @HttpCode(200)
  resume(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.run(auth, param, 'resume', {}, req);
  }

  /** `{ minutes, reason }`: the new expected start is the scheduled start plus the delay. */
  @Post('class-sessions/:id/delay')
  @RequirePermissions('class_sessions.delay')
  @HttpCode(200)
  delay(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'delay', parseInput(DelayClassSchema, body), req);
  }

  /** `{ reasonCode, note? }`; "OTHER" needs a note. */
  @Post('class-sessions/:id/cancel')
  @RequirePermissions('class_sessions.cancel')
  @HttpCode(200)
  cancel(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'cancel', parseInput(CancelClassSchema, body), req);
  }

  /** The class's lecturer, or an administrator for an interrupted class (checked in the service). */
  @Post('class-sessions/:id/end')
  @Authenticated()
  @HttpCode(200)
  end(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.run(auth, param, 'end', {}, req);
  }

  /** `{ reason }`. The class's lecturer or an administrator (checked in the service). */
  @Post('class-sessions/:id/interrupt')
  @Authenticated()
  @HttpCode(200)
  interrupt(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'interrupt', parseInput(ClassReasonSchema, body), req);
  }

  @Post('class-sessions/:id/suspend')
  @RequirePermissions('class_sessions.suspend')
  @HttpCode(200)
  suspend(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'suspend', parseInput(ClassReasonSchema, body), req);
  }

  @Post('class-sessions/:id/lift-hold')
  @RequirePermissions('class_sessions.suspend')
  @HttpCode(200)
  liftHold(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'liftHold', parseInput(ClassReasonSchema, body), req);
  }

  /** `{ reason, reasonCode? }`: cancels a class that had started; nothing is deleted. */
  @Post('class-sessions/:id/void')
  @RequirePermissions('class_sessions.void')
  @HttpCode(200)
  voidClass(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'void', parseInput(VoidClassSchema, body), req);
  }

  @Post('class-sessions/:id/reinstate')
  @RequirePermissions('class_sessions.void')
  @HttpCode(200)
  reinstate(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.run(auth, param, 'reinstate', parseInput(ClassReasonSchema, body), req);
  }

  @Post('class-sessions/:id/open-review')
  @RequirePermissions('class_reviews.decide')
  @HttpCode(200)
  async openReview(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const sessionId = parseInput(IdSchema, param);
    const { reason } = parseInput(ClassReasonSchema, body);
    await this.monitor.adminOpenReview(auth, sessionId, reason, requestContextOf(req));
    return this.sessions.get(sessionId);
  }

  private async run(
    auth: AccessClaims,
    param: string,
    action: ClassActionName,
    input: ActionInput,
    req: Request,
  ) {
    const sessionId = parseInput(IdSchema, param);
    await this.events.act(auth, sessionId, action, input, requestContextOf(req));
    return this.sessions.get(sessionId);
  }
}
