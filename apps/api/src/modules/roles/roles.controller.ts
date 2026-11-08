import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ReplaceRolePermissionsSchema, ROLE_KEYS } from '@attendsure/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { RolesService } from './roles.service.js';

const RoleKeyParam = z.enum(ROLE_KEYS);

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.edit_permissions')
  list() {
    return this.roles.list();
  }

  @Put(':key/permissions')
  @RequirePermissions('roles.edit_permissions')
  replacePermissions(
    @CurrentAuth() auth: AccessClaims,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const input = parseInput(ReplaceRolePermissionsSchema, body);
    return this.roles.replacePermissions(
      auth,
      parseInput(RoleKeyParam, key),
      input.permissions,
      input.reason,
      requestContextOf(req),
    );
  }
}
