import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BeaconQuerySchema,
  AddMeasurementsSchema,
  CalibrationSurveySchema,
  CreateBeaconSchema,
  UpdateBeaconSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Beacon, CalibrationSurvey, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PlacesService } from '../places/places.service.js';
import { type BeaconCalibration, calibrate } from './calibration.js';

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const DUPLICATE = {
  unique: {
    code: 'DUPLICATE_BEACON',
    message: 'A beacon with this protocol and identifier is already registered.',
  },
};

/**
 * The beacon register and calibration surveys (PRESENCE_VERIFICATION.md §3). Rooms belong to the
 * places module; this module owns beacons and surveys. Changes need university-wide scope, as for
 * rooms. Rotating keys are stored encrypted and never returned.
 */
@Injectable()
export class BeaconsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly places: PlacesService,
    private readonly encryption: EncryptionService,
    private readonly clock: Clock,
  ) {}

  async list(query: z.output<typeof BeaconQuerySchema>) {
    const rows = await this.prisma.beacon.findMany({
      where: {
        ...(query.classroomId ? { classroomId: query.classroomId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ classroomId: 'asc' }, { label: 'asc' }],
    });
    return { data: await this.views(rows) };
  }

  /**
   * The beacons phones listen for: active (or suspected faulty) beacons with a fixed identifier.
   * Rotating-ID beacons are left out until their broadcasts can be resolved (D-08, limitation 57).
   */
  async scanList() {
    const rows = await this.prisma.beacon.findMany({
      where: {
        status: { in: ['ACTIVE', 'SUSPECTED_FAULTY'] },
        protocol: { in: ['EDDYSTONE_UID', 'IBEACON'] },
      },
      select: { id: true, classroomId: true, protocol: true, identifier: true, thresholdRssi: true },
    });
    return rows;
  }

  async get(id: string) {
    const beacon = await this.find(id);
    const [view] = await this.views([beacon]);
    return view!;
  }

  async create(actor: AccessClaims, input: z.output<typeof CreateBeaconSchema>, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    await this.assertRoom(input.classroomId);
    const beacon = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.beacon.create({
          data: {
            classroomId: input.classroomId,
            label: input.label,
            protocol: input.protocol,
            identifier: input.identifier,
            rotationKeyEnc: input.rotationKey
              ? this.encryption.encrypt(input.rotationKey.toLowerCase())
              : null,
            rotationExponent: input.rotationExponent ?? null,
            txPowerDbm: input.txPowerDbm ?? null,
            installedOn: input.installedOn ? new Date(`${input.installedOn}T00:00:00Z`) : null,
            notes: input.notes ?? null,
            createdAt: this.clock.now(),
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'beacons.created',
            { type: 'beacon', id: created.id },
            { after: this.auditView(created) },
            context,
          ),
          tx,
        );
        return created;
      })
      .catch((e: unknown) => rethrowAsConflict(e, DUPLICATE));
    return this.get(beacon.id);
  }

  /**
   * Edits a beacon (If-Match version). Moving it to another room or switching it off needs a reason,
   * and moving it clears its threshold: a beacon must be calibrated again where it now hangs.
   */
  async update(
    actor: AccessClaims,
    id: string,
    expectedVersion: number,
    input: z.output<typeof UpdateBeaconSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    const before = await this.find(id);
    const moved = input.classroomId !== undefined && input.classroomId !== before.classroomId;
    const switchedOff = input.status === 'INACTIVE' && before.status !== 'INACTIVE';
    if ((moved || switchedOff) && !input.reason) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason when a beacon moves to another room or is switched off.',
      });
    }
    if (moved) await this.assertRoom(input.classroomId!);
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.beacon.updateMany({
        where: { id, version: expectedVersion },
        data: {
          label: input.label,
          classroomId: input.classroomId,
          status: input.status,
          txPowerDbm: input.txPowerDbm,
          batteryPercent: input.batteryPercent,
          batteryReportedAt: input.batteryPercent !== undefined ? this.clock.now() : undefined,
          installedOn: input.installedOn ? new Date(`${input.installedOn}T00:00:00Z`) : undefined,
          notes: input.notes,
          ...(moved ? { thresholdRssi: null, calibratedAt: null } : {}),
          version: { increment: 1 },
        },
      });
      if (done.count !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Someone else changed this beacon since you opened it. Reload it and try again.',
          errors: { currentVersion: before.version },
        });
      }
      const after = await tx.beacon.findUniqueOrThrow({ where: { id } });
      await this.audit.record(
        auditEntry(
          actor,
          'beacons.updated',
          { type: 'beacon', id },
          { before: this.auditView(before), after: this.auditView(after), reason: input.reason },
          context,
        ),
        tx,
      );
    });
    return this.get(id);
  }

  // ───────── Calibration surveys ─────────

  /** Records a survey exactly as measured, with its computed result. Nothing changes until applied. */
  async createSurvey(
    actor: AccessClaims,
    input: z.output<typeof CalibrationSurveySchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    await this.assertRoom(input.classroomId);
    const beaconIds = await this.assertBeaconsInRoom(input.classroomId, input.measurements);
    const result = calibrate(input.measurements, beaconIds);
    const now = this.clock.now();
    const survey = await this.prisma.$transaction(async (tx) => {
      const created = await tx.calibrationSurvey.create({
        data: {
          classroomId: input.classroomId,
          surveyedById: actor.userId,
          surveyedAt: now,
          notes: input.notes ?? null,
          result: result as unknown as Prisma.InputJsonValue,
          measurements: { create: input.measurements },
        },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'calibration_surveys.created',
          { type: 'calibration_survey', id: created.id },
          { after: { classroomId: input.classroomId, readings: input.measurements.length, result } },
          context,
        ),
        tx,
      );
      return created;
    });
    return this.surveyView(survey);
  }

  /**
   * Adds another phone's readings to a survey that has not been applied (each phone can only measure
   * itself, and a threshold needs several phone models). Readings are only ever added; the result is
   * recomputed from all of them. The survey row is locked so this cannot race with applying it.
   */
  async addMeasurements(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof AddMeasurementsSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    const survey = await this.prisma.calibrationSurvey.findUnique({ where: { id } });
    if (!survey) throw notFound('survey');
    await this.assertRoom(survey.classroomId);
    await this.assertBeaconsInRoom(survey.classroomId, input.measurements);
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM calibration_surveys WHERE id = ${id}::uuid AND applied_at IS NULL FOR UPDATE`;
      if (open.length !== 1) {
        throw new ConflictException({
          code: 'ALREADY_APPLIED',
          message: 'This survey has already been applied. Start a new survey.',
        });
      }
      await tx.calibrationMeasurement.createMany({
        data: input.measurements.map((m) => ({ ...m, surveyId: id })),
      });
      const all = await tx.calibrationMeasurement.findMany({ where: { surveyId: id } });
      const result = calibrate(all, [...new Set(all.map((m) => m.beaconId))]);
      await tx.calibrationSurvey.update({
        where: { id },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'calibration_surveys.measurements_added',
          { type: 'calibration_survey', id },
          {
            before: { result: survey.result },
            after: { readingsAdded: input.measurements.length, result },
          },
          context,
        ),
        tx,
      );
    });
    return this.getSurvey(id);
  }

  async listSurveys(classroomId?: string) {
    const rows = await this.prisma.calibrationSurvey.findMany({
      where: classroomId ? { classroomId } : {},
      orderBy: { surveyedAt: 'desc' },
      take: 200,
    });
    return { data: rows.map((r) => this.surveyView(r)) };
  }

  async getSurvey(id: string) {
    const row = await this.prisma.calibrationSurvey.findUnique({
      where: { id },
      include: { measurements: { orderBy: [{ beaconId: 'asc' }, { position: 'asc' }] } },
    });
    if (!row) throw notFound('survey');
    return {
      ...this.surveyView(row),
      measurements: row.measurements.map((m) => ({
        beaconId: m.beaconId,
        phoneModel: m.phoneModel,
        platform: m.platform,
        position: m.position,
        rssi: m.rssi,
      })),
    };
  }

  /**
   * Sets each surveyed beacon's threshold from the survey. Refused if any beacon has a problem
   * (overlap, too few phones, missing readings): a threshold that cannot separate inside from
   * outside would mislead the verification engine. A survey is applied once.
   */
  async applySurvey(actor: AccessClaims, id: string, reason: string | undefined, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    const survey = await this.prisma.calibrationSurvey.findUnique({ where: { id } });
    if (!survey) throw notFound('survey');
    if (survey.appliedAt) {
      throw new ConflictException({
        code: 'ALREADY_APPLIED',
        message: 'This survey has already been applied.',
      });
    }
    const now = this.clock.now();
    let result: BeaconCalibration[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Locked, so readings added at the same moment are either in this result or refused.
      const locked = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT result FROM calibration_surveys WHERE id = ${id}::uuid AND applied_at IS NULL FOR UPDATE`;
      if (locked.length !== 1) {
        throw new ConflictException({
          code: 'ALREADY_APPLIED',
          message: 'This survey has already been applied.',
        });
      }
      result = locked[0]!.result as BeaconCalibration[];
      const problems = result.filter((r) => r.problem);
      if (problems.length > 0) {
        throw new ConflictException({
          code: 'SURVEY_HAS_PROBLEMS',
          message:
            'Some beacons could not be calibrated from this survey. Fix the placement or measure again.',
          errors: { beacons: problems.map((p) => ({ beaconId: p.beaconId, problem: p.problem })) },
        });
      }
      await tx.calibrationSurvey.update({
        where: { id },
        data: { appliedAt: now, appliedById: actor.userId },
      });
      for (const r of result) {
        const updated = await tx.beacon.updateMany({
          where: { id: r.beaconId, classroomId: survey.classroomId },
          data: { thresholdRssi: r.thresholdRssi, calibratedAt: now, version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            code: 'BEACON_MOVED',
            message: 'A surveyed beacon has since moved to another room. Survey the room again.',
          });
        }
      }
      await this.audit.record(
        auditEntry(
          actor,
          'calibration_surveys.applied',
          { type: 'calibration_survey', id },
          {
            after: {
              thresholds: result.map((r) => ({ beaconId: r.beaconId, thresholdRssi: r.thresholdRssi })),
            },
            reason,
          },
          context,
        ),
        tx,
      );
    });
    return this.getSurvey(id);
  }

  /** Every reading must be of a beacon registered to the surveyed room. Returns the beacons read. */
  private async assertBeaconsInRoom(classroomId: string, measurements: { beaconId: string }[]) {
    const beaconIds = [...new Set(measurements.map((m) => m.beaconId))];
    const beacons = await this.prisma.beacon.findMany({ where: { id: { in: beaconIds } } });
    const foreign = beaconIds.filter((b) => beacons.find((x) => x.id === b)?.classroomId !== classroomId);
    if (foreign.length > 0) {
      throw new BadRequestException({
        code: 'BEACON_NOT_IN_ROOM',
        message: 'Every reading must be of a beacon registered to the surveyed room.',
        errors: { beaconIds: foreign },
      });
    }
    return beaconIds;
  }

  private async assertRoom(classroomId: string) {
    const room = (await this.places.classroomFacts([classroomId])).get(classroomId);
    if (!room?.isActive) {
      throw new BadRequestException({ code: 'INVALID_CLASSROOM', message: 'No such room in use.' });
    }
  }

  private async find(id: string) {
    const beacon = await this.prisma.beacon.findUnique({ where: { id } });
    if (!beacon) throw notFound('beacon');
    return beacon;
  }

  private async views(rows: Beacon[]) {
    const rooms = await this.places.classroomFacts(rows.map((r) => r.classroomId));
    return rows.map((b) => {
      const room = rooms.get(b.classroomId);
      return {
        id: b.id,
        classroom: room ? { id: room.id, code: room.code, name: room.name } : null,
        label: b.label,
        protocol: b.protocol,
        identifier: b.identifier,
        hasRotationKey: b.rotationKeyEnc !== null,
        rotationExponent: b.rotationExponent,
        txPowerDbm: b.txPowerDbm,
        thresholdRssi: b.thresholdRssi,
        calibratedAt: b.calibratedAt,
        status: b.status,
        batteryPercent: b.batteryPercent,
        batteryReportedAt: b.batteryReportedAt,
        installedOn: b.installedOn?.toISOString().slice(0, 10) ?? null,
        notes: b.notes,
        version: b.version,
      };
    });
  }

  /** What is audited about a beacon: never the key. */
  private auditView(b: Beacon) {
    return {
      classroomId: b.classroomId,
      label: b.label,
      protocol: b.protocol,
      identifier: b.identifier,
      status: b.status,
      thresholdRssi: b.thresholdRssi,
      txPowerDbm: b.txPowerDbm,
    };
  }

  private surveyView(s: CalibrationSurvey) {
    return {
      id: s.id,
      classroomId: s.classroomId,
      surveyedById: s.surveyedById,
      surveyedAt: s.surveyedAt,
      notes: s.notes,
      result: s.result as unknown as BeaconCalibration[],
      appliedAt: s.appliedAt,
      appliedById: s.appliedById,
    };
  }
}
