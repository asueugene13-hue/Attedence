import { Controller, Get, Param, Query } from '@nestjs/common';
import { BeaconHealthQuerySchema, IdSchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { BeaconHealthService } from './beacon-health.service.js';

/** Beacon health (Phase 4 step 5): what phones have heard from a beacon. */
@Controller()
export class BeaconHealthController {
  constructor(private readonly health: BeaconHealthService) {}

  /** `?hours=24`: status, when it was last heard, and its 5-minute summaries (newest first). */
  @Get('beacons/:id/health')
  @RequirePermissions('beacon_health.read')
  get(@Param('id') id: string, @Query() query: unknown) {
    return this.health.health(parseInput(IdSchema, id), parseInput(BeaconHealthQuerySchema, query).hours);
  }
}
