import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CheckInSchema, IdSchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import type { UserDevice } from '../../generated/prisma/client.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { DeviceSignatureGuard, SignedDevice } from '../devices/device-signature.guard.js';
import { CheckInService } from './check-in.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Student check-in (ATTENDANCE_FLOW.md §2). */
@Controller()
export class CheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  /**
   * Signed by the phone, with an `Idempotency-Key` header (a UUID): a repeated key returns the first
   * answer. `{ qrToken, bluetooth, readings, location, appVersion? }` → the outcome. Every decided
   * check-in is 200, including rejections (the answer explains what to do).
   */
  @Post('check-ins')
  @Authenticated()
  @UseGuards(DeviceSignatureGuard)
  @HttpCode(200)
  checkIn(
    @CurrentAuth() auth: AccessClaims,
    @SignedDevice() device: UserDevice,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || !UUID.test(key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Send an Idempotency-Key header (a UUID) with every check-in.',
      });
    }
    return this.checkIns.checkIn(auth, device, key.toLowerCase(), parseInput(CheckInSchema, body));
  }

  /** The student's own check-in, for polling after a reconnect. */
  @Get('check-ins/:id')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') id: string) {
    return this.checkIns.getMine(auth, parseInput(IdSchema, id));
  }
}
