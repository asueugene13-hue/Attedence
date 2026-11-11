import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ClassroomCheckSchema } from '@attendsure/shared';
import { parseInput } from '../../common/validation/parse-input.js';
import type { UserDevice } from '../../generated/prisma/client.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { BeaconsService } from '../beacons/beacons.service.js';
import { PlacesService } from '../places/places.service.js';
import { DeviceSignatureGuard, SignedDevice } from '../devices/device-signature.guard.js';
import { ClassroomCheckService } from './classroom-check.service.js';

/** What the phone listens for, and "Check this classroom" (Phase 4 step 4). */
@Controller()
export class ClassroomCheckController {
  constructor(
    private readonly checks: ClassroomCheckService,
    private readonly beacons: BeaconsService,
    private readonly places: PlacesService,
  ) {}

  /**
   * The registered beacon identifiers a phone should listen for (anything else is ignored), with
   * each one's room, and the rooms in use that have beacons (to choose from). Thresholds stay on the
   * server.
   */
  @Get('me/beacon-scan-list')
  @Authenticated()
  async scanList() {
    const rows = await this.beacons.scanList();
    const facts = await this.places.classroomFacts(rows.map((b) => b.classroomId));
    const rooms = [...facts.values()]
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, code: r.code, name: r.name }))
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      data: rows
        .filter((b) => facts.get(b.classroomId)?.isActive)
        .map((b) => ({
          id: b.id,
          identifier: b.identifier,
          protocol: b.protocol,
          classroomId: b.classroomId,
        })),
      rooms,
    };
  }

  /**
   * Signed by the phone. `{ classroomId, bluetooth: ON|OFF|DENIED, readings: [{ identifier, rssi }],
   * location: { latitude, longitude, accuracyM, isMocked? } | null }` → the evidence and the decision
   * the current policy would make. Nothing is recorded.
   */
  @Post('classroom-checks')
  @Authenticated()
  @UseGuards(DeviceSignatureGuard)
  @HttpCode(200)
  check(@SignedDevice() device: UserDevice, @Body() body: unknown) {
    return this.checks.check(device, parseInput(ClassroomCheckSchema, body));
  }
}
