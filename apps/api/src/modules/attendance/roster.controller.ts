import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApproveWaitingSchema,
  AssistedCheckInSchema,
  DecideRecordSchema,
  IdSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { RosterService } from './roster.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** The live roster and the lecturer's decisions (ATTENDANCE_FLOW §6–§7). Who may: see the service. */
@Controller()
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  /** The full roster with `seq`; reload it on a gap in live events or after reconnecting. */
  @Get('attendance-sessions/:id/roster')
  @Authenticated()
  get(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.roster.roster(auth, id(param));
  }

  /** `{ decision: APPROVE | REJECT, note? (required to reject), version }` on a waiting check-in. */
  @Post('attendance-records/:id/decide')
  @Authenticated()
  @HttpCode(200)
  decide(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.roster.decide(auth, id(param), parseInput(DecideRecordSchema, body), requestContextOf(req));
  }

  /** Degraded mode only: `{ note? }` approves every check-in waiting only because the beacon failed. */
  @Post('attendance-sessions/:id/approve-waiting')
  @Authenticated()
  @HttpCode(200)
  approveWaiting(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { note } = parseInput(ApproveWaitingSchema, body ?? {});
    return this.roster.approveWaiting(auth, id(param), note, requestContextOf(req));
  }

  /** `{ studentId, method, reason }`: the lecturer checks a student in by hand. */
  @Post('attendance-sessions/:id/assisted-check-ins')
  @Authenticated()
  assist(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.roster.assist(
      auth,
      id(param),
      parseInput(AssistedCheckInSchema, body),
      requestContextOf(req),
    );
  }
}
