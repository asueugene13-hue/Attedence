import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { LIFECYCLE_TIMING, type OpenAttendanceSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { AttendanceCloseReason, AttendanceSession, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { ClassEventService } from '../class-sessions/class-event.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { makeToken, newQrSecret, windowAt, windowEndsAt } from './qr.js';

type ClassFacts = NonNullable<ReturnType<Awaited<ReturnType<ClassSessionsService['facts']>>['get']>>;
type Tx = Prisma.TransactionClient;

const MINUTE = 60_000;
const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
const SWEEP_EVERY_MS = MINUTE;

const conflict = (code: string, message: string) => new ConflictException({ code, message });
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such attendance session.' });

/**
 * Attendance sessions (ATTENDANCE_FLOW.md §1, §5; Phase 5 step 1): opening (with the class start in
 * one tap), the rotating QR, closing (marking eligible students without a record ABSENT), extending,
 * reopening once, and voiding records when the class is voided. Times are server time.
 */
@Injectable()
export class AttendanceSessionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly jobs: JobRegistry,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly classSessions: ClassSessionsService,
    private readonly classEvents: ClassEventService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly enrollments: EnrollmentsService,
    private readonly settings: SettingsService,
    private readonly policies: VerificationPolicyService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    this.jobs.define({
      queue: 'monitoring',
      name: 'attendance-sweep',
      attempts: 3,
      handle: async () => {
        await this.sweep();
      },
    });
    this.jobs.every('monitoring', 'attendance-sweep', SWEEP_EVERY_MS);
  }

  // ───────── Opening ─────────

  /** The class's own lecturer opens attendance; by default the class is started in the same transaction. */
  async open(
    actor: AccessClaims,
    classSessionId: string,
    input: z.output<typeof OpenAttendanceSchema>,
    context: RequestContext,
  ) {
    const cls = await this.classFacts(classSessionId);
    await this.assertOwnLecturer(actor, cls);
    if (await this.prisma.attendanceSession.findUnique({ where: { classSessionId } })) {
      throw conflict(
        'ATTENDANCE_ALREADY_OPENED',
        'Attendance was already taken for this class. Reopen it instead.',
      );
    }
    const [lateMinutes, closeMinutes, policy] = await Promise.all([
      input.lateAfterMinutes ?? this.settings.get('attendance.lateAfterMinutes'),
      input.closeAfterMinutes ?? this.settings.get('attendance.closeAfterMinutes'),
      this.policies.current(),
    ]);
    const create = async (tx: Tx, now: Date) => {
      if (now >= cls.scheduledEnd) {
        throw conflict(
          'CLASS_OVER',
          'The scheduled end of this class has passed; attendance can no longer be opened.',
        );
      }
      const opened = await tx.attendanceSession.create({
        data: {
          classSessionId,
          openedById: actor.userId,
          openedAt: now,
          lateAfter: new Date(Math.max(now.getTime(), cls.scheduledStart.getTime()) + lateMinutes * MINUTE),
          closesAt: new Date(now.getTime() + closeMinutes * MINUTE),
          qrSecretEnc: this.encryption.encrypt(newQrSecret()),
          qrRotationSeconds: policy.rules.qrRotationSeconds,
          verificationPolicyVersion: policy.version,
        },
      });
      await this.classEvents.recordAttendanceEvent(
        tx,
        classSessionId,
        'ATTENDANCE_OPENED',
        actor.userId,
        {
          attendanceSessionId: opened.id,
          lateAfter: opened.lateAfter.toISOString(),
          closesAt: opened.closesAt.toISOString(),
        },
        now,
      );
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.opened',
          { type: 'attendance_session', id: opened.id },
          {
            after: {
              classSessionId,
              lateAfter: opened.lateAfter,
              closesAt: opened.closesAt,
              policyVersion: policy.version,
            },
          },
          context,
        ),
        tx,
      );
      return opened;
    };

    let opened: AttendanceSession | undefined;
    if (cls.status === 'ACTIVE') {
      opened = await this.prisma
        .$transaction(async (tx) => create(tx, this.clock.now()))
        .catch(rethrowDuplicate);
    } else if (input.startClass) {
      // One tap: the class starts and attendance opens together, or neither happens.
      await this.classEvents
        .act(actor, classSessionId, 'start', {}, context, async (tx, _session, now) => {
          opened = await create(tx, now);
          return { attendanceSessionId: opened.id };
        })
        .catch(rethrowDuplicate);
    } else {
      throw conflict('CLASS_NOT_STARTED', 'Start the class first, or open attendance with the class start.');
    }
    return this.view(opened!);
  }

  // ───────── The QR ─────────

  /** The current token for the lecturer's screen (also the fallback when live updates are down). */
  async currentQr(actor: AccessClaims, id: string) {
    const session = await this.find(id);
    await this.assertOwnLecturer(actor, await this.classFacts(session.classSessionId));
    const now = this.clock.now();
    if (session.status !== 'OPEN' || now >= session.closesAt) {
      throw conflict('ATTENDANCE_CLOSED', 'Attendance is closed for this class.');
    }
    const window = windowAt(session.openedAt, now, session.qrRotationSeconds);
    return {
      token: makeToken(this.encryption.decrypt(session.qrSecretEnc), session.id, window),
      window,
      rotationSeconds: session.qrRotationSeconds,
      expiresAt: windowEndsAt(session.openedAt, window, session.qrRotationSeconds),
      serverTime: now,
      closesAt: session.closesAt,
    };
  }

  // ───────── Closing, extending, reopening ─────────

  /** The lecturer closes early; an administrator in scope can force-close, with a reason. */
  async close(actor: AccessClaims, id: string, reason: string | undefined, context: RequestContext) {
    const session = await this.find(id);
    const cls = await this.classFacts(session.classSessionId);
    const asAdmin = await this.lecturerOrAdmin(actor, cls, 'attendance.open', 'attendance.force_close');
    if (asAdmin && !reason) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Say why attendance is being closed.',
      });
    }
    const closed = await this.prisma.$transaction((tx) =>
      this.closeInTx(tx, session, asAdmin ? 'FORCED' : 'MANUAL', actor.userId, this.clock.now()),
    );
    if (!closed) throw conflict('ATTENDANCE_CLOSED', 'Attendance is already closed.');
    await this.audit.record(
      auditEntry(
        actor,
        asAdmin ? 'attendance.force_closed' : 'attendance.closed',
        { type: 'attendance_session', id },
        { after: { absentMarked: closed.absent }, reason },
        context,
      ),
    );
    return this.view(await this.find(id));
  }

  /** More time to check in, with a reason; never past the point where a running class is auto-ended. */
  async extend(actor: AccessClaims, id: string, minutes: number, reason: string, context: RequestContext) {
    const session = await this.find(id);
    const cls = await this.classFacts(session.classSessionId);
    await this.assertOwnLecturer(actor, cls);
    const now = this.clock.now();
    if (session.status !== 'OPEN' || now >= session.closesAt) {
      throw conflict('ATTENDANCE_CLOSED', 'Attendance is closed; reopen it instead.');
    }
    const latest = new Date(cls.scheduledEnd.getTime() + LIFECYCLE_TIMING.autoEndAfterMinutes * MINUTE);
    const closesAt = new Date(session.closesAt.getTime() + minutes * MINUTE);
    if (closesAt > latest) {
      throw conflict(
        'TOO_LATE',
        'Attendance cannot stay open that long after the scheduled end of the class.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, session, { closesAt });
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.extended',
          { type: 'attendance_session', id },
          { before: { closesAt: session.closesAt }, after: { closesAt }, reason },
          context,
        ),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  /** Once, before the scheduled end, with a reason. Records made when it closed can still go up. */
  async reopen(actor: AccessClaims, id: string, minutes: number, reason: string, context: RequestContext) {
    const session = await this.find(id);
    const cls = await this.classFacts(session.classSessionId);
    await this.assertOwnLecturer(actor, cls);
    const now = this.clock.now();
    if (session.status !== 'CLOSED') throw conflict('ATTENDANCE_OPEN', 'Attendance is still open.');
    if (session.closeReason === 'CLASS_VOIDED') throw conflict('CLASS_VOIDED', 'This class was voided.');
    if (session.reopenedAt) throw conflict('ALREADY_REOPENED', 'Attendance can be reopened only once.');
    if (cls.status !== 'ACTIVE' || now >= cls.scheduledEnd) {
      throw conflict(
        'CLASS_OVER',
        'Attendance can be reopened only while the class is running, before its scheduled end.',
      );
    }
    const closesAt = new Date(Math.min(now.getTime() + minutes * MINUTE, cls.scheduledEnd.getTime()));
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, session, {
        status: 'OPEN',
        closesAt,
        reopenedAt: now,
        closedAt: null,
        closedById: null,
        closeReason: null,
      });
      await this.classEvents.recordAttendanceEvent(
        tx,
        cls.id,
        'ATTENDANCE_REOPENED',
        actor.userId,
        { attendanceSessionId: id, closesAt: closesAt.toISOString(), reason },
        now,
      );
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.reopened',
          { type: 'attendance_session', id },
          {
            before: { status: 'CLOSED', closeReason: session.closeReason },
            after: { status: 'OPEN', closesAt },
            reason,
          },
          context,
        ),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  /**
   * Closes an open session in the caller's transaction: every eligible student without a record is
   * marked ABSENT (safe to repeat), and the class history records it. Returns null if it was not open.
   */
  private async closeInTx(
    tx: Tx,
    session: AttendanceSession,
    reason: AttendanceCloseReason,
    actorUserId: string | null,
    now: Date,
  ) {
    const claimed = await tx.attendanceSession.updateMany({
      where: { id: session.id, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedAt: now,
        closedById: actorUserId,
        closeReason: reason,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    const cls = (await this.classSessions.facts([session.classSessionId], tx)).get(session.classSessionId)!;
    const eligible = await this.enrollments.eligibleAt(cls.sectionIds, cls.scheduledStart, tx);
    const absent = await tx.attendanceRecord.createMany({
      data: eligible.map((studentId) => ({
        classSessionId: cls.id,
        attendanceSessionId: session.id,
        studentId,
        status: 'ABSENT' as const,
        source: 'CLOSE' as const,
      })),
      skipDuplicates: true,
    });
    await this.classEvents.recordAttendanceEvent(
      tx,
      cls.id,
      'ATTENDANCE_CLOSED',
      actorUserId,
      { attendanceSessionId: session.id, reason, absentMarked: absent.count },
      now,
    );
    return { absent: absent.count };
  }

  // ───────── The sweeper (server time) ─────────

  /**
   * Every minute: closes sessions whose time is up (AUTO) or whose class ended (CLASS_ENDED), and voids
   * the records of a class that was voided after attendance started. Safe to run repeatedly.
   */
  async sweep(): Promise<{ closed: number; voided: number }> {
    const now = this.clock.now();
    let closed = 0;
    let voided = 0;
    const open = await this.prisma.attendanceSession.findMany({ where: { status: 'OPEN' } });
    const facts = await this.classSessions.facts(open.map((s) => s.classSessionId));
    for (const session of open) {
      const cls = facts.get(session.classSessionId);
      if (!cls || cls.status === 'CANCELLED') continue; // voided: handled below
      const reason: AttendanceCloseReason | null =
        cls.status === 'COMPLETED' ? 'CLASS_ENDED' : now >= session.closesAt ? 'AUTO' : null;
      if (!reason) continue;
      if (await this.prisma.$transaction((tx) => this.closeInTx(tx, session, reason, null, now))) closed++;
    }
    // A class voided after attendance started (only a void cancels a started class).
    const candidates = await this.prisma.attendanceSession.findMany({
      where: { OR: [{ closeReason: null }, { closeReason: { not: 'CLASS_VOIDED' } }] },
    });
    const candidateFacts = await this.classSessions.facts(candidates.map((s) => s.classSessionId));
    for (const session of candidates) {
      if (candidateFacts.get(session.classSessionId)?.status !== 'CANCELLED') continue;
      if (await this.voidSession(session, now)) voided++;
    }
    return { closed, voided };
  }

  /** Every record becomes VOIDED, each with a correction; the session is closed as CLASS_VOIDED. */
  private async voidSession(session: AttendanceSession, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (session.status === 'OPEN') {
        // Mark eligible students first, so every student of the class ends up with a VOIDED record.
        await this.closeInTx(tx, session, 'CLASS_VOIDED', null, now);
      }
      const claimed = await tx.attendanceSession.updateMany({
        where: { id: session.id, status: 'CLOSED', NOT: { closeReason: 'CLASS_VOIDED' } },
        data: { closeReason: 'CLASS_VOIDED', version: { increment: 1 } },
      });
      if (claimed.count !== 1 && session.status !== 'OPEN') return false;
      const records = await tx.attendanceRecord.findMany({
        where: { attendanceSessionId: session.id, status: { not: 'VOIDED' } },
      });
      for (const r of records) {
        await tx.attendanceRecord.update({
          where: { id: r.id },
          data: { status: 'VOIDED', version: { increment: 1 } },
        });
        await tx.attendanceCorrection.create({
          data: {
            recordId: r.id,
            fromStatus: r.status,
            toStatus: 'VOIDED',
            reason: 'The class was voided.',
            source: 'VOID',
            correctedAt: now,
          },
        });
      }
      await this.classEvents.recordAttendanceEvent(
        tx,
        session.classSessionId,
        'ATTENDANCE_VOIDED',
        null,
        { attendanceSessionId: session.id, records: records.length },
        now,
      );
      await this.audit.record(
        {
          action: 'attendance.voided',
          entityType: 'attendance_session',
          entityId: session.id,
          after: { records: records.length },
        },
        tx,
      );
      return true;
    });
  }

  // ───────── Reading ─────────

  async get(actor: AccessClaims, id: string) {
    const session = await this.find(id);
    await this.lecturerOrAdmin(
      actor,
      await this.classFacts(session.classSessionId),
      'attendance.roster_read',
      'attendance.roster_read',
    );
    return this.view(session);
  }

  /** The attendance session of a class, or null if attendance was never opened. */
  async forClass(actor: AccessClaims, classSessionId: string) {
    const cls = await this.classFacts(classSessionId);
    await this.lecturerOrAdmin(actor, cls, 'attendance.roster_read', 'attendance.roster_read');
    const session = await this.prisma.attendanceSession.findUnique({ where: { classSessionId } });
    return session ? this.view(session) : null;
  }

  private async view(session: AttendanceSession) {
    const counts = await this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: { attendanceSessionId: session.id },
      _count: { _all: true },
    });
    return {
      id: session.id,
      classSessionId: session.classSessionId,
      status: session.status,
      openedAt: session.openedAt,
      lateAfter: session.lateAfter,
      closesAt: session.closesAt,
      closedAt: session.closedAt,
      closeReason: session.closeReason,
      reopenedAt: session.reopenedAt,
      qrRotationSeconds: session.qrRotationSeconds,
      policyVersion: session.verificationPolicyVersion,
      version: session.version,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  // ───────── Helpers ─────────

  private async find(id: string) {
    const session = await this.prisma.attendanceSession.findUnique({ where: { id } });
    if (!session) throw notFound();
    return session;
  }

  private async classFacts(id: string): Promise<ClassFacts> {
    const cls = (await this.classSessions.facts([id])).get(id);
    if (!cls) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    return cls;
  }

  /** Updates the session only if nobody changed it first (same version). */
  private async claim(
    tx: Tx,
    session: AttendanceSession,
    data: Prisma.AttendanceSessionUncheckedUpdateManyInput,
  ) {
    const claimed = await tx.attendanceSession.updateMany({
      where: { id: session.id, version: session.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw conflict(
        'ATTENDANCE_CHANGED',
        'Attendance for this class changed a moment ago. Reload and try again.',
      );
    }
  }

  private async assertOwnLecturer(actor: AccessClaims, cls: ClassFacts) {
    if (actor.role !== 'LECTURER' || (await this.lecturers.idForUser(actor.userId)) !== cls.lecturerId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_CLASS',
        message: 'Only the lecturer of this class can do this.',
      });
    }
  }

  /**
   * The class's own lecturer holding `lecturerPermission`, or an administrator within scope holding
   * `adminPermission`. Returns true when acting as an administrator.
   */
  private async lecturerOrAdmin(
    actor: AccessClaims,
    cls: ClassFacts,
    lecturerPermission: string,
    adminPermission: string,
  ): Promise<boolean> {
    const held = await this.permissions.forRole(actor.role);
    if (actor.role === 'LECTURER' && held.has(lecturerPermission)) {
      await this.assertOwnLecturer(actor, cls);
      return false;
    }
    if (!ADMIN_ROLES.includes(actor.role) || !held.has(adminPermission)) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });
    }
    const sections = await this.courses.sectionSummaries(cls.sectionIds);
    for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
    return true;
  }
}

/** Two lecturers' devices opening at once: the unique class key decides; the second gets a clear answer. */
function rethrowDuplicate(error: unknown): never {
  if (dbErrorInfo(error)?.pgCode === PG.uniqueViolation) {
    throw conflict('ATTENDANCE_ALREADY_OPENED', 'Attendance was already opened for this class.');
  }
  throw error;
}
