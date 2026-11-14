import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  AnnouncementFeedQuerySchema,
  AnnouncementListQuerySchema,
  HideAnnouncementSchema,
  IdSchema,
  ReportAnnouncementSchema,
  SendAnnouncementSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { AnnouncementsService } from './announcements.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/**
 * Announcements (Phase 6 step 4). Who may send, read, report and hide each one depends on the role,
 * the sections taught or represented and the administrator's scope, so the service checks it.
 */
@Controller()
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** What the caller may send to (and, for a course rep, how many updates each section has left today). */
  @Get('announcements/targets')
  @Authenticated()
  targets(@CurrentAuth() auth: AccessClaims) {
    return this.announcements.targets(auth);
  }

  /** `{ scope, sectionIds? | departmentId? | facultyId?, title, body, email }`. */
  @Post('announcements')
  @Authenticated()
  send(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.announcements.send(auth, parseInput(SendAnnouncementSchema, body), requestContextOf(req));
  }

  /** `?view=MINE` (default) or `REPORTED`. */
  @Get('announcements')
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.announcements.list(auth, parseInput(AnnouncementListQuerySchema, query).view);
  }

  @Get('announcements/:id/stats')
  @Authenticated()
  stats(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.announcements.stats(auth, id(param));
  }

  /** `{ reason }`: moderators only. The announcement is kept, but no longer shown. */
  @Post('announcements/:id/hide')
  @Authenticated()
  @HttpCode(200)
  hide(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(HideAnnouncementSchema, body);
    return this.announcements.hide(auth, id(param), reason, requestContextOf(req));
  }

  /** `{ reason }`: a recipient reports it (once). */
  @Post('announcements/:id/report')
  @Authenticated()
  @HttpCode(200)
  report(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReportAnnouncementSchema, body);
    return this.announcements.report(auth, id(param), reason, requestContextOf(req));
  }

  /** The caller's announcements, newest first: `?kind=OFFICIAL|COURSE_REP&limit=&cursor=`. */
  @Get('me/announcements')
  @Authenticated()
  feed(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.announcements.feed(auth, parseInput(AnnouncementFeedQuerySchema, query));
  }

  @Get('me/announcements/unread-count')
  @Authenticated()
  unread(@CurrentAuth() auth: AccessClaims) {
    return this.announcements.unreadCount(auth);
  }

  @Post('me/announcements/:id/read')
  @Authenticated()
  @HttpCode(200)
  read(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.announcements.markRead(auth, id(param));
  }
}
