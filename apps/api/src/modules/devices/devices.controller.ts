import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  DeviceApproveSchema,
  DeviceListQuerySchema,
  DeviceRefuseSchema,
  IdSchema,
  RegisterDeviceSchema,
  TrustRequestSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import type { UserDevice } from '../../generated/prisma/client.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { DeviceSignatureGuard, SignedDevice } from './device-signature.guard.js';
import { DevicesService } from './devices.service.js';

/** Trusted phones (D-10): the signed-in person's own phones, and approvals for staff. */
@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** The app registers the phone it runs on after each sign-in. `{ installationId, platform, publicKey, … }`. */
  @Post('me/devices')
  @Authenticated()
  @HttpCode(200)
  register(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.devices.register(auth, parseInput(RegisterDeviceSchema, body), requestContextOf(req));
  }

  @Get('me/devices')
  @Authenticated()
  mine(@CurrentAuth() auth: AccessClaims) {
    return this.devices.mine(auth.userId);
  }

  /** The phone this request was signed by: proves the phone holds its key, and shows its status. */
  @Get('me/devices/current')
  @Authenticated()
  @UseGuards(DeviceSignatureGuard)
  current(@SignedDevice() device: UserDevice) {
    return this.devices.view(device);
  }

  /** `{ reason }`: make this phone my attendance phone (needs approval). */
  @Post('me/devices/:id/request-trust')
  @RequirePermissions('devices.request_replacement')
  @HttpCode(200)
  requestTrust(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(TrustRequestSchema, body);
    return this.devices.requestTrust(auth, parseInput(IdSchema, param), reason, requestContextOf(req));
  }

  /** `?requested=true` (waiting for a decision), `status=`, `q=` (name, email or Student ID). */
  @Get('devices')
  @RequirePermissions('devices.approve')
  list(@CurrentAuth() auth: AccessClaims, @Query() query: unknown) {
    return this.devices.list(auth, parseInput(DeviceListQuerySchema, query));
  }

  @Post('devices/:id/approve')
  @RequirePermissions('devices.approve')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { note } = parseInput(DeviceApproveSchema, body ?? {});
    return this.devices.approve(auth, parseInput(IdSchema, param), note, requestContextOf(req));
  }

  /** `{ reason }`: refuse a waiting phone, or revoke a trusted one (lost or stolen). */
  @Post('devices/:id/revoke')
  @RequirePermissions('devices.approve')
  @HttpCode(200)
  revoke(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(DeviceRefuseSchema, body);
    return this.devices.revoke(auth, parseInput(IdSchema, param), reason, requestContextOf(req));
  }
}
