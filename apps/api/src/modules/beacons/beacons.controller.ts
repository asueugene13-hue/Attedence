import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApplySurveySchema,
  BeaconQuerySchema,
  CalibrationSurveySchema,
  CreateBeaconSchema,
  IdSchema,
  SurveyQuerySchema,
  UpdateBeaconSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { expectedVersion } from '../../common/if-match.js';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { BeaconsService } from './beacons.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** Classroom beacons and calibration surveys (PRESENCE_VERIFICATION.md §3). */
@Controller()
export class BeaconsController {
  constructor(private readonly beacons: BeaconsService) {}

  /** `?classroomId=&status=`. Rotating keys are never returned. */
  @Get('beacons')
  @RequirePermissions('beacon_health.read')
  list(@Query() query: unknown) {
    return this.beacons.list(parseInput(BeaconQuerySchema, query));
  }

  @Get('beacons/:id')
  @RequirePermissions('beacon_health.read')
  get(@Param('id') param: string) {
    return this.beacons.get(id(param));
  }

  @Post('beacons')
  @RequirePermissions('beacons.manage')
  create(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.beacons.create(auth, parseInput(CreateBeaconSchema, body), requestContextOf(req));
  }

  /** If-Match: version. Moving or switching off needs `reason`; moving clears the threshold. */
  @Patch('beacons/:id')
  @RequirePermissions('beacons.manage')
  update(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.beacons.update(
      auth,
      id(param),
      expectedVersion(req, 'beacon'),
      parseInput(UpdateBeaconSchema, body),
      requestContextOf(req),
    );
  }

  @Get('calibration-surveys')
  @RequirePermissions('beacons.manage')
  surveys(@Query() query: unknown) {
    return this.beacons.listSurveys(parseInput(SurveyQuerySchema, query).classroomId);
  }

  @Get('calibration-surveys/:id')
  @RequirePermissions('beacons.manage')
  survey(@Param('id') param: string) {
    return this.beacons.getSurvey(id(param));
  }

  /** `{ classroomId, notes?, measurements: [{ beaconId, phoneModel, platform, position, rssi }] }`. */
  @Post('calibration-surveys')
  @RequirePermissions('beacons.manage')
  createSurvey(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.beacons.createSurvey(auth, parseInput(CalibrationSurveySchema, body), requestContextOf(req));
  }

  /** Sets each surveyed beacon's threshold. Refused if any beacon could not be calibrated. */
  @Post('calibration-surveys/:id/apply')
  @RequirePermissions('beacons.manage')
  @HttpCode(200)
  apply(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { reason } = parseInput(ApplySurveySchema, body ?? {});
    return this.beacons.applySurvey(auth, id(param), reason, requestContextOf(req));
  }
}
