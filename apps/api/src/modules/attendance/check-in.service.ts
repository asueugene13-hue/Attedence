import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type AttendanceStatus,
  type CheckInSchema,
  RECORD_RANK,
  STUDENT_MESSAGES,
  type VerificationReason,
} from '@attendsure/shared';
import type { z } from 'zod';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { Prisma, UserDevice } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ClassEventService } from '../class-sessions/class-event.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { RiskFlagsService } from '../risk-flags/risk-flags.service.js';
import { StudentsService } from '../students/students.service.js';
import { BeaconHealthService } from '../verification/beacon-health.service.js';
import { type Decision, decide } from '../verification/decision-engine.js';
import { EvidenceService } from '../verification/evidence.service.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { AttendanceEventsService } from './attendance-events.service.js';
import { checkToken, parseToken, windowAt, windowEndsAt } from './qr.js';
import { RosterService } from './roster.service.js';

/** Reasons that stop a check-in before any evidence counts: these never create or change a record. */
const GATE_REASONS: readonly VerificationReason[] = [
  'QR_INVALID',
  'QR_EXPIRED',
  'SESSION_NOT_OPEN',
  'NOT_ENROLLED',
  'ACCOUNT_INACTIVE',
  'DEVICE_REVOKED',
  'TOO_MANY_ATTEMPTS',
];

/** Requests per student per minute (on top of the per-address limit); a real student needs a few. */
const RATE_LIMIT_PER_MINUTE = 20;

export interface CheckInResponse {
  /** Null when nothing could be recorded (the code is not an AttendSure attendance code). */
  attemptId: string | null;
  outcome: Decision['outcome'];
  reason: VerificationReason | null;
  message: string;
  retryAllowed: boolean;
  canAskForReview: boolean;
  /** The student's attendance record for the class after this attempt, if they have one. */
  recordStatus: AttendanceStatus | null;
  receivedAt: string;
}

type CheckIn = z.output<typeof CheckInSchema>;

/**
 * Check-in (ATTENDANCE_FLOW.md §2, Phase 5 step 2). The phone sends the scanned QR and its evidence,
 * signed by its key; the server decides with the policy in force when attendance opened, records every
 * attempt with the full rule trace, and moves the student's record up (never down). Server time only.
 */
@Injectable()
export class CheckInService {
  private readonly logger = new Logger(CheckInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
    private readonly classSessions: ClassSessionsService,
    private readonly classEvents: ClassEventService,
    private readonly policies: VerificationPolicyService,
    private readonly evidence: EvidenceService,
    private readonly beaconHealth: BeaconHealthService,
    private readonly flags: RiskFlagsService,
    private readonly events: AttendanceEventsService,
    private readonly roster: RosterService,
  ) {}

  async checkIn(
    actor: AccessClaims,
    device: UserDevice,
    idempotencyKey: string,
    input: CheckIn,
  ): Promise<CheckInResponse> {
    const studentId = await this.students.idForUser(actor.userId);
    if (!studentId) {
      throw new ForbiddenException({ code: 'NOT_A_STUDENT', message: 'Only students check in.' });
    }
    const replay = await this.prisma.attendanceAttempt.findUnique({
      where: { studentId_idempotencyKey: { studentId, idempotencyKey } },
    });
    if (replay) return replay.response as unknown as CheckInResponse;
    await this.rateLimit(studentId);

    const now = this.clock.now();
    const token = parseToken(input.qrToken);
    const session = token
      ? await this.prisma.attendanceSession.findUnique({ where: { id: token.sessionId } })
      : null;
    if (!token || !session) {
      // Not an attendance code for any session: nothing to attach an attempt to.
      return this.unrecorded('QR_INVALID', now);
    }
    const cls = (await this.classSessions.facts([session.classSessionId])).get(session.classSessionId)!;
    const policy =
      (await this.policies.byVersion(session.verificationPolicyVersion)) ?? (await this.policies.current());
    const rules = policy.rules;

    // The QR: current window or the grace before it; a little older is accepted as a delayed upload.
    const currentWindow = windowAt(session.openedAt, now, session.qrRotationSeconds);
    const qrCheck = checkToken(
      token,
      this.encryption.decrypt(session.qrSecretEnc),
      currentWindow,
      rules.qrGraceWindows,
    );
    let qr: 'VALID' | 'INVALID' | 'EXPIRED' = qrCheck.valid
      ? 'VALID'
      : qrCheck.reason === 'QR_EXPIRED'
        ? 'EXPIRED'
        : 'INVALID';
    let delayedUpload = false;
    if (qr === 'EXPIRED') {
      const validUntil = windowEndsAt(
        session.openedAt,
        token.window + rules.qrGraceWindows,
        session.qrRotationSeconds,
      );
      if (now.getTime() <= validUntil.getTime() + rules.offlineGraceSeconds * 1000) {
        qr = 'VALID';
        delayedUpload = true;
      }
    }

    const [enrolled, priorAttempts, otherStudentOnPhone, degraded, e] = await Promise.all([
      this.enrollments.isEligible(studentId, cls.sectionIds, cls.scheduledStart),
      this.prisma.attendanceAttempt.findMany({
        where: { attendanceSessionId: session.id, studentId },
        select: { outcome: true, retryAllowed: true },
      }),
      this.prisma.attendanceAttempt.count({
        where: {
          attendanceSessionId: session.id, // The same physical phone (installation) used by another student in this class.
          device: { installationId: device.installationId },
          NOT: { studentId },
        },
      }),
      this.classEvents.isBeaconDegraded(cls.id),
      this.evidence.collect(device, { ...input, classroomId: cls.classroomId }, rules),
    ]);
    let decision = decide(
      {
        qr,
        sessionOpen: session.status === 'OPEN' && now < session.closesAt,
        enrolled,
        accountActive: true, // a suspended account's sessions are ended, so it cannot get here
        device: device.status,
        attemptsSoFar: priorAttempts.length,
        retryRejectionsSoFar: priorAttempts.filter((a) => a.outcome === 'REJECTED' && a.retryAllowed).length,
        ble: e.ble,
        gps: e.gps,
        integrity: e.integrity,
        sharedDeviceInSession: otherStudentOnPhone > 0,
        degradedMode: degraded,
      },
      rules,
    );
    if (delayedUpload && decision.outcome === 'VERIFIED') {
      // §8: a late upload cannot be fully trusted, so the lecturer confirms it.
      decision = {
        ...decision,
        outcome: 'PENDING_VERIFICATION',
        reason: 'DELAYED_UPLOAD',
        message: STUDENT_MESSAGES.DELAYED_UPLOAD,
        trace: [...decision.trace, 'delayed upload within the offline grace: at most PENDING_VERIFICATION'],
      };
    }
    const passedGates = !(decision.reason && GATE_REASONS.includes(decision.reason));
    const candidate: AttendanceStatus | null = !passedGates
      ? null
      : decision.outcome === 'VERIFIED'
        ? now > session.lateAfter
          ? 'LATE'
          : 'PRESENT'
        : decision.outcome === 'PENDING_VERIFICATION'
          ? 'PENDING'
          : decision.outcome === 'MANUAL_REVIEW_REQUIRED'
            ? 'UNDER_REVIEW'
            : 'REJECTED';
    const evidence = {
      ble: e.ble,
      strongestOwnRssi: e.strongestOwnRssi,
      recognisedReadings: e.heard.length,
      bluetooth: input.bluetooth,
      gps: e.gps,
      distanceM: e.distanceM,
      accuracyM: input.location?.accuracyM ?? null,
      hasGeofence: e.hasGeofence,
      device: device.status,
      integrity: e.integrity,
      degradedMode: degraded,
      sharedDeviceInSession: otherStudentOnPhone > 0,
    };

    let response: CheckInResponse;
    try {
      response = await this.save({
        session,
        cls,
        studentId,
        device,
        idempotencyKey,
        now,
        token,
        qrValid: qr === 'VALID',
        delayedUpload,
        decision,
        candidate,
        evidence,
        policyVersion: policy.version,
        appVersion: input.appVersion,
      });
    } catch (error) {
      if (dbErrorInfo(error)?.pgCode !== PG.uniqueViolation) throw error;
      // The same request arrived twice at once: the first one's answer is the answer.
      const winner = await this.prisma.attendanceAttempt.findUnique({
        where: { studentId_idempotencyKey: { studentId, idempotencyKey } },
      });
      if (winner) return winner.response as unknown as CheckInResponse;
      // Two different first check-ins at once: the record now exists, so this one raises it.
      response = await this.save({
        session,
        cls,
        studentId,
        device,
        idempotencyKey,
        now,
        token,
        qrValid: qr === 'VALID',
        delayedUpload,
        decision,
        candidate,
        evidence,
        policyVersion: policy.version,
        appVersion: input.appVersion,
      });
    }

    // After the commit: the lecturer's roster, beacon health and risk flags (none of them changes
    // the student's result).
    try {
      await this.events.publish(session.id, 'record.updated', await this.roster.entry(session.id, studentId));
    } catch (error) {
      this.logger.error(`Roster event failed for attempt ${response.attemptId}: ${String(error)}`);
    }
    if (passedGates) {
      try {
        await this.beaconHealth.recordObservation(
          {
            deviceId: device.id,
            classroomId: cls.classroomId,
            bluetooth: input.bluetooth,
            location: input.location,
            heard: e.heard,
          },
          e.room,
        );
      } catch (error) {
        this.logger.error(`Beacon health report failed for attempt ${response.attemptId}: ${String(error)}`);
      }
    }
    for (const type of decision.flags) {
      await this.flags.raise({
        type,
        severity: type === 'MOCK_LOCATION' || type === 'SHARED_DEVICE' ? 'HIGH' : 'MEDIUM',
        studentId,
        deviceId: device.id,
        evidence: {
          attemptId: response.attemptId,
          attendanceSessionId: session.id,
          classSessionId: cls.id,
          reason: decision.reason,
        },
        dedupeKey: `${type}:${session.id}:${studentId}`,
      });
    }
    return response;
  }

  /** The student's own attempt, for polling after a reconnect. */
  async getMine(actor: AccessClaims, attemptId: string): Promise<CheckInResponse> {
    const studentId = await this.students.idForUser(actor.userId);
    const attempt = await this.prisma.attendanceAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || !studentId || attempt.studentId !== studentId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such check-in.' });
    }
    return attempt.response as unknown as CheckInResponse;
  }

  /** One transaction: the attempt, the engine's decision with its trace, and the record (only up). */
  private save(a: {
    session: { id: string; classSessionId: string };
    cls: { id: string };
    studentId: string;
    device: UserDevice;
    idempotencyKey: string;
    now: Date;
    token: { window: number };
    qrValid: boolean;
    delayedUpload: boolean;
    decision: Decision;
    candidate: AttendanceStatus | null;
    evidence: Record<string, Prisma.InputJsonValue | null>;
    policyVersion: number;
    appVersion: string | undefined;
  }): Promise<CheckInResponse> {
    return this.prisma.$transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<{ id: string; status: AttendanceStatus }[]>`
        SELECT id, status FROM attendance_records
        WHERE class_session_id = ${a.cls.id}::uuid AND student_id = ${a.studentId}::uuid FOR UPDATE`;
      const raises =
        a.candidate !== null && (!existing || RECORD_RANK[a.candidate] > RECORD_RANK[existing.status]);
      const attemptId = randomUUID();
      const response: CheckInResponse = {
        attemptId,
        outcome: a.decision.outcome,
        reason: a.decision.reason,
        message: a.decision.message,
        retryAllowed: a.decision.retryAllowed,
        canAskForReview: a.decision.canAskForReview,
        recordStatus: raises ? a.candidate : (existing?.status ?? null),
        receivedAt: a.now.toISOString(),
      };
      await tx.attendanceAttempt.create({
        data: {
          id: attemptId,
          attendanceSessionId: a.session.id,
          studentId: a.studentId,
          deviceId: a.device.id,
          idempotencyKey: a.idempotencyKey,
          receivedAt: a.now,
          qrWindow: a.qrValid ? a.token.window : null,
          delayedUpload: a.delayedUpload,
          outcome: a.decision.outcome,
          reason: a.decision.reason,
          retryAllowed: a.decision.retryAllowed,
          canAskForReview: a.decision.canAskForReview,
          evidence: a.evidence,
          policyVersion: a.policyVersion,
          response: response as unknown as Prisma.InputJsonValue,
          appVersion: a.appVersion ?? null,
        },
      });
      await tx.verificationDecision.create({
        data: {
          attemptId,
          outcome: a.decision.outcome,
          decidedBy: 'ENGINE',
          policyVersion: a.policyVersion,
          ruleTrace: a.decision.trace,
          decidedAt: a.now,
        },
      });
      if (raises && !existing) {
        await tx.attendanceRecord.create({
          data: {
            classSessionId: a.cls.id,
            attendanceSessionId: a.session.id,
            studentId: a.studentId,
            status: a.candidate!,
            source: 'CHECK_IN',
            checkedInAt: a.now,
            attemptId,
          },
        });
      } else if (raises && existing) {
        await tx.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            status: a.candidate!,
            source: 'CHECK_IN',
            checkedInAt: a.now,
            attemptId,
            version: { increment: 1 },
          },
        });
      }
      return response;
    });
  }

  private unrecorded(reason: 'QR_INVALID', now: Date): CheckInResponse {
    return {
      attemptId: null,
      outcome: 'REJECTED',
      reason,
      message: STUDENT_MESSAGES[reason],
      retryAllowed: true,
      canAskForReview: false,
      recordStatus: null,
      receivedAt: now.toISOString(),
    };
  }

  private async rateLimit(studentId: string): Promise<void> {
    const key = `rate:check-in:${studentId}`;
    try {
      const [[, count]] = (await this.redis.client.multi().incr(key).expire(key, 60, 'NX').exec()) as [
        [unknown, number],
      ];
      if (count > RATE_LIMIT_PER_MINUTE) {
        throw new HttpException(
          { code: 'TOO_MANY_REQUESTS', message: 'Too many check-in requests. Wait a minute and try again.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // As for the other limits: if Redis is down, the limit is skipped (and logged), never the check-in.
      this.logger.warn(`Check-in rate limit skipped: ${String(error)}`);
    }
  }
}
