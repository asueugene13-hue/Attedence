import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { IdSchema, SettingKeySchema, SystemEventQuerySchema, UpdateSettingSchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { SettingsService } from './settings.service.js';
import { SystemHealthService } from './system-health.service.js';

function expectedVersion(req: Request): number {
  const header = req.headers['if-match'];
  const value = typeof header === 'string' ? Number(header.replace(/"/g, '')) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException({
      code: 'VERSION_REQUIRED',
      message: 'Send the If-Match header with the setting version you are changing.',
    });
  }
  return value;
}

@Controller()
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly health: SystemHealthService,
  ) {}

  @Get('settings')
  @RequirePermissions('settings.manage')
  list() {
    return this.settings.list();
  }

  /** `{ value, reason }` with If-Match: the version shown with the setting (0 while it is the default). */
  @Put('settings/:key')
  @RequirePermissions('settings.manage')
  update(
    @CurrentAuth() auth: AccessClaims,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const settingKey = parseInput(SettingKeySchema, key);
    const version = expectedVersion(req);
    const input = parseInput(UpdateSettingSchema, body);
    return this.settings.update(auth, settingKey, version, input.value, input.reason, requestContextOf(req));
  }

  @Get('system-events')
  @RequirePermissions('system_health.read')
  events(@Query() query: unknown) {
    return this.health.list(parseInput(SystemEventQuerySchema, query));
  }

  @Post('system-events/:id/acknowledge')
  @RequirePermissions('system_health.read')
  @HttpCode(200)
  acknowledge(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.health.acknowledge(auth, parseInput(IdSchema, param), requestContextOf(req));
  }
}
