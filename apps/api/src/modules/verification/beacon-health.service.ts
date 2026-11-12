import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { BeaconsService } from '../beacons/beacons.service.js';
import { ClassEventService } from '../class-sessions/class-event.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { PlacesService } from '../places/places.service.js';
import { RiskFlagsService } from '../risk-flags/risk-flags.service.js';
import {
  assessRoom,
  CONFLICT_WINDOW_MINUTES,
  findConflict,
  HEALTH_WINDOW_MINUTES,
  isUnexpectedSighting,
  summarise,
  windowStart,
} from './beacon-health.js';
import { evaluateGps, type Geofence, type GpsReading } from './evidence.js';
import { VerificationPolicyService } from './verification-policy.service.js';

export interface ObservationInput {
  deviceId: string;
  classroomId: string;
  bluetooth: 'ON' | 'OFF' | 'DENIED';
  location: GpsReading | null;
  /** Registered beacons heard (already matched from identifiers), any number of readings each. */
  heard: { beaconId: string; rssi: number }[];
}

const SUMMARY_EVERY_MS = HEALTH_WINDOW_MINUTES * 60_000;

/**
 * Beacon health (PRESENCE_VERIFICATION.md §3, Phase 4 step 5). Check-in (Phase 5) reports what each
 * phone heard through recordObservation(); from these reports:
 * - a beacon that phones on site cannot hear during a class becomes "suspected faulty", and that class
 *   enters degraded mode (a class event, which alerts the lecturer and administrators);
 * - a suspected-faulty beacon that is heard again becomes active again;
 * - a beacon heard far from its site, or in two distant places at once, raises a risk flag for review;
 * - every 5 minutes, a summary per beacon (sightings, phones, median signal).
 * None of this decides a student's attendance or punishes anyone.
 */
@Injectable()
export class BeaconHealthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly jobs: JobRegistry,
    private readonly policies: VerificationPolicyService,
    private readonly beacons: BeaconsService,
    private readonly places: PlacesService,
    private readonly classSessions: ClassSessionsService,
    private readonly classEvents: ClassEventService,
    private readonly flags: RiskFlagsService,
  ) {}

  onModuleInit(): void {
    this.jobs.define({
      queue: 'monitoring',
      name: 'beacon-health-summary',
      attempts: 3,
      handle: async () => {
        await this.summariseRecent();
      },
    });
    this.jobs.every('monitoring', 'beacon-health-summary', SUMMARY_EVERY_MS);
  }

  /** Records one phone's report and acts on it. Returns what was concluded, for check-in to use. */
  async recordObservation(input: ObservationInput) {
    const now = this.clock.now();
    const [policy, scanList, geofence, running] = await Promise.all([
      this.policies.current(),
      this.beacons.scanList(),
      this.places.geofenceForClassroom(input.classroomId),
      this.classSessions.runningInRoom(input.classroomId, now),
    ]);
    const rules = policy.rules;
    const site = (g: Awaited<typeof geofence>): Geofence | null =>
      g ? { latitude: g.lat, longitude: g.lng, radiusM: g.radiusM } : null;
    const gps = evaluateGps(input.location, site(geofence), rules);
    // Strongest reading per registered beacon; identifiers not on the scan list were already dropped.
    const known = new Map(scanList.map((b) => [b.id, b]));
    const strongest = new Map<string, number>();
    for (const h of input.heard) {
      if (!known.has(h.beaconId)) continue;
      strongest.set(h.beaconId, Math.max(strongest.get(h.beaconId) ?? -999, Math.round(h.rssi)));
    }
    const usable = input.location && !input.location.isMocked ? input.location : null;

    const observation = await this.prisma.beaconObservation.create({
      data: {
        classroomId: input.classroomId,
        classSessionId: running?.id ?? null,
        deviceId: input.deviceId,
        observedAt: now,
        bluetooth: input.bluetooth,
        gps: gps.result,
        latitude: input.location?.latitude ?? null,
        longitude: input.location?.longitude ?? null,
        accuracyM: input.location ? Math.round(input.location.accuracyM) : null,
        sightings: {
          create: [...strongest].map(([beaconId, rssi]) => ({ beaconId, rssi, observedAt: now })),
        },
      },
    });

    await this.checkAnomalies(observation.id, input.deviceId, usable, [...strongest.keys()], now, rules);

    // Heard again: a suspected-faulty beacon is broadcasting, so it is working.
    const recovered = await this.beacons.markHeardAgain(
      [...strongest.keys()].filter((id) => known.get(id)?.status === 'SUSPECTED_FAULTY'),
      { observationId: observation.id },
    );

    // Silent beacon during a class: suspected fault and degraded mode.
    const roomBeacons = scanList.filter((b) => b.classroomId === input.classroomId);
    let degraded = false;
    let suspectedNow: string[] = [];
    if (running && roomBeacons.length > 0) {
      const roomIds = new Set(roomBeacons.map((b) => b.id));
      const since = new Date(now.getTime() - rules.beaconFaultWindowMinutes * 60_000);
      const recent = await this.prisma.beaconObservation.findMany({
        where: { classroomId: input.classroomId, observedAt: { gte: since, lte: now } },
        select: {
          deviceId: true,
          observedAt: true,
          bluetooth: true,
          gps: true,
          sightings: { select: { beaconId: true } },
        },
      });
      const assessment = assessRoom(
        recent.map((r) => ({
          deviceId: r.deviceId,
          observedAt: r.observedAt,
          bluetooth: r.bluetooth,
          gps: r.gps,
          heardRoomBeacon: r.sightings.some((s) => roomIds.has(s.beaconId)),
        })),
        now,
        rules,
      );
      const stillSuspected = roomBeacons.every(
        (b) => b.status === 'SUSPECTED_FAULTY' && !recovered.includes(b.id),
      );
      if (assessment.suspected) {
        suspectedNow = await this.beacons.markSuspectedFaulty(
          roomBeacons.filter((b) => b.status === 'ACTIVE').map((b) => b.id),
          {
            classSessionId: running.id,
            silentDevices: assessment.silentDevices,
            windowMinutes: rules.beaconFaultWindowMinutes,
          },
        );
      }
      // Degraded while the room's beacons are suspected faulty (now or from an earlier class).
      if (assessment.suspected || stillSuspected) {
        await this.classEvents.recordBeaconDegraded(running.id, {
          beaconIds: roomBeacons.map((b) => b.id),
          devices: assessment.silentDevices,
          windowMinutes: rules.beaconFaultWindowMinutes,
        });
      }
      degraded = await this.classEvents.isBeaconDegraded(running.id);
    }
    return {
      observationId: observation.id,
      gps: gps.result,
      classSessionId: running?.id ?? null,
      degraded,
      suspectedFaulty: suspectedNow,
      heardAgain: recovered,
    };
  }

  /** Risk flags for a person to review; they change nothing by themselves. */
  private async checkAnomalies(
    observationId: string,
    deviceId: string,
    location: GpsReading | null,
    beaconIds: string[],
    now: Date,
    rules: Awaited<ReturnType<VerificationPolicyService['current']>>['rules'],
  ) {
    if (!location || beaconIds.length === 0) return;
    const scan = new Map((await this.beacons.scanList()).map((b) => [b.id, b]));
    const since = new Date(now.getTime() - CONFLICT_WINDOW_MINUTES * 60_000);
    for (const beaconId of beaconIds) {
      const beacon = scan.get(beaconId);
      if (!beacon) continue;
      const fence = await this.places.geofenceForClassroom(beacon.classroomId);
      const unexpected = isUnexpectedSighting(
        location,
        fence ? { latitude: fence.lat, longitude: fence.lng, radiusM: fence.radiusM } : null,
        rules,
      );
      if (unexpected.unexpected) {
        await this.flags.raise({
          type: 'UNEXPECTED_BEACON',
          severity: 'MEDIUM',
          deviceId,
          evidence: {
            beaconId,
            classroomId: beacon.classroomId,
            observationId,
            distanceFromSiteM: Math.round(unexpected.distanceM ?? 0),
            accuracyM: location.accuracyM,
          },
          dedupeKey: `unexpected-beacon:${beaconId}:${deviceId}`,
        });
      }
      const others = await this.prisma.beaconSighting.findMany({
        where: {
          beaconId,
          observedAt: { gte: since, lte: now },
          observationId: { not: observationId },
          observation: { latitude: { not: null } },
        },
        select: {
          observation: {
            select: { id: true, deviceId: true, latitude: true, longitude: true, accuracyM: true },
          },
        },
      });
      const conflict = findConflict(
        location,
        others.map((o) => ({
          id: o.observation.id,
          deviceId: o.observation.deviceId,
          latitude: o.observation.latitude!,
          longitude: o.observation.longitude!,
          accuracyM: o.observation.accuracyM ?? 0,
        })),
        rules,
      );
      if (conflict) {
        await this.flags.raise({
          type: 'BEACON_LOCATION_CONFLICT',
          severity: 'HIGH',
          deviceId,
          evidence: {
            beaconId,
            classroomId: beacon.classroomId,
            observationIds: [observationId, conflict.other.id],
            otherDeviceId: conflict.other.deviceId,
            separationM: conflict.separationM,
          },
          dedupeKey: `beacon-conflict:${beaconId}`,
        });
      }
    }
  }

  /** Summaries for the previous and current 5-minute windows (re-running is safe: rows are replaced). */
  async summariseRecent(): Promise<number> {
    const now = this.clock.now();
    const from = new Date(windowStart(now).getTime() - HEALTH_WINDOW_MINUTES * 60_000);
    const sightings = await this.prisma.beaconSighting.findMany({
      where: { observedAt: { gte: from, lte: now } },
      select: { beaconId: true, rssi: true, observedAt: true, observation: { select: { deviceId: true } } },
    });
    const rows = summarise(sightings.map((s) => ({ ...s, deviceId: s.observation.deviceId })));
    for (const row of rows) {
      await this.prisma.beaconHealthSnapshot.upsert({
        where: { beaconId_windowStart: { beaconId: row.beaconId, windowStart: row.windowStart } },
        create: row,
        update: {
          sightings: row.sightings,
          distinctDevices: row.distinctDevices,
          medianRssi: row.medianRssi,
        },
      });
    }
    return rows.length;
  }

  /** A beacon's status, when it was last heard, and its summaries for the last `hours`. */
  async health(beaconId: string, hours: number) {
    const beacon = await this.beacons.get(beaconId);
    const since = new Date(this.clock.now().getTime() - hours * 3_600_000);
    const [snapshots, last] = await Promise.all([
      this.prisma.beaconHealthSnapshot.findMany({
        where: { beaconId, windowStart: { gte: since } },
        orderBy: { windowStart: 'desc' },
      }),
      this.prisma.beaconSighting.findFirst({ where: { beaconId }, orderBy: { observedAt: 'desc' } }),
    ]);
    return {
      beacon,
      lastHeardAt: last?.observedAt ?? null,
      windows: snapshots.map((s) => ({
        windowStart: s.windowStart,
        sightings: s.sightings,
        distinctDevices: s.distinctDevices,
        medianRssi: s.medianRssi,
      })),
    };
  }
}
