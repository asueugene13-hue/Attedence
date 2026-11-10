import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { NewPolicyVersionSchema, TryDecisionSchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { VerificationPolicyService } from './verification-policy.service.js';

/** The verification policy (PRESENCE_VERIFICATION.md §9) and a way to try it. */
@Controller('verification-policies')
export class VerificationController {
  constructor(private readonly policies: VerificationPolicyService) {}

  @Get('current')
  @RequirePermissions('verification_policies.manage')
  current() {
    return this.policies.current();
  }

  /** Every version, newest first, ending with the defaults (version 0). */
  @Get()
  @RequirePermissions('verification_policies.manage')
  history() {
    return this.policies.history();
  }

  /** `{ rules, reason }`: a new version. Turning the beacon requirement off needs a Super Admin. */
  @Post()
  @RequirePermissions('verification_policies.manage')
  create(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    const { rules, reason } = parseInput(NewPolicyVersionSchema, body);
    return this.policies.create(auth, rules, reason, requestContextOf(req));
  }

  /** `{ ble, gps, device?, integrity?, … }`: what the current policy would decide. Nothing is saved. */
  @Post('try')
  @RequirePermissions('verification_policies.manage')
  @HttpCode(200)
  tryCase(@Body() body: unknown) {
    return this.policies.tryCase(parseInput(TryDecisionSchema, body));
  }
}
