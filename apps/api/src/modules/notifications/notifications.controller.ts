import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { IdSchema, NotificationListQuerySchema, UpdatePreferenceSchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { NotificationsService } from './notifications.service.js';

/** The signed-in person's notifications and channel choices. Nobody sees anyone else's. */
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** `?unread=true&limit=&cursor=` newest first. */
  @Get('notifications')
  @Authenticated()
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.notifications.list(auth.userId, parseInput(NotificationListQuerySchema, query));
  }

  @Get('notifications/unread-count')
  @Authenticated()
  unread(@CurrentAuth() auth: AccessClaims) {
    return this.notifications.unreadCount(auth.userId);
  }

  @Post('notifications/read-all')
  @Authenticated()
  @HttpCode(200)
  readAll(@CurrentAuth() auth: AccessClaims) {
    return this.notifications.markAllRead(auth.userId);
  }

  @Post('notifications/:id/read')
  @Authenticated()
  @HttpCode(200)
  read(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.notifications.markRead(auth.userId, parseInput(IdSchema, param));
  }

  @Get('notification-preferences')
  @Authenticated()
  preferences(@CurrentAuth() auth: AccessClaims) {
    return this.notifications.preferences(auth.userId);
  }

  /** `{ category, channel: EMAIL|PUSH, enabled }`. Mandatory categories cannot be turned off. */
  @Put('notification-preferences')
  @Authenticated()
  setPreference(@CurrentAuth() auth: AccessClaims, @Body() body: unknown) {
    return this.notifications.setPreference(auth.userId, parseInput(UpdatePreferenceSchema, body));
  }
}
