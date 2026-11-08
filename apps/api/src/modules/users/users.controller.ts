import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CreateStaffUserSchema,
  GrantRoleSchema,
  IdSchema,
  ReasonOnlySchema,
  UserListQuerySchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.manage_admins')
  list(@Query() query: unknown) {
    return this.users.list(parseInput(UserListQuerySchema, query));
  }

  @Post()
  @RequirePermissions('users.manage_admins', 'roles.assign')
  @HttpCode(201)
  create(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.users.create(auth, parseInput(CreateStaffUserSchema, body), requestContextOf(req));
  }

  @Get(':id')
  @RequirePermissions('users.manage_admins')
  get(@Param('id') id: string) {
    return this.users.get(parseInput(IdSchema, id));
  }

  @Post(':id/activation-email')
  @RequirePermissions('users.manage_admins')
  @HttpCode(204)
  async resendActivation(@CurrentAuth() auth: AccessClaims, @Param('id') id: string, @Req() req: Request) {
    await this.users.resendActivation(auth, parseInput(IdSchema, id), requestContextOf(req));
  }

  @Post(':id/suspend')
  @RequirePermissions('accounts.suspend')
  @HttpCode(200)
  suspend(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.users.suspend(auth, parseInput(IdSchema, id), reason, requestContextOf(req));
  }

  @Post(':id/restore')
  @RequirePermissions('accounts.suspend')
  @HttpCode(200)
  restore(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.users.restore(auth, parseInput(IdSchema, id), reason, requestContextOf(req));
  }

  @Post(':id/mfa/reset')
  @RequirePermissions('users.manage_admins')
  @HttpCode(200)
  resetMfa(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.users.resetMfa(auth, parseInput(IdSchema, id), reason, requestContextOf(req));
  }

  @Post(':id/roles')
  @RequirePermissions('roles.assign')
  @HttpCode(200)
  grantRole(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const input = parseInput(GrantRoleSchema, body);
    return this.users.grantRole(
      auth,
      parseInput(IdSchema, id),
      input.role,
      input.reason,
      requestContextOf(req),
    );
  }

  @Post(':id/roles/:grantId/revoke')
  @RequirePermissions('roles.assign')
  @HttpCode(200)
  revokeRole(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ReasonOnlySchema, body);
    return this.users.revokeRole(
      auth,
      parseInput(IdSchema, id),
      parseInput(IdSchema, grantId),
      reason,
      requestContextOf(req),
    );
  }
}
