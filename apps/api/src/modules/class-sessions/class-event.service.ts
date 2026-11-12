import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ADMIN_ONLY_CANCEL_REASONS,
  CLASS_ACTIONS,
  type ClassActionName,
  LIFECYCLE_TIMING,
  SYSTEM_TRANSITIONS,
  type SystemTransition,
} from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type {
  CancelReason,
  ClassEventType,
  ClassSession,
  Prisma,
  ReviewDecision,
} from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { writeClassEvent } from './class-event-log.js';

/**
 * Extra work done in the same transaction as the status change, before it (a reschedule creates the
 * replacement session here). Whatever it returns is added to the class event and the audit entry.
 */
export type InTransaction = (
  tx: Prisma.TransactionClient,
  session: ClassSession,
  now: Date,
) => Promise<Record<string, Prisma.InputJsonValue>>;

export interface ActionInput {
  reason?: string;
  minutes?: number;
  reasonCode?: CancelReason;
  note?: string;
  /** The administrator's note when this change decides an open review. */
  reviewNote?: string;
}

const EVENT: Record<ClassActionName, ClassEventType> = {
  confirm: 'CONFIRMED',
  delay: 'DELAY_REPORTED',
  start: 'STARTED',
  end: 'ENDED',
  interrupt: 'INTERRUPTED',
  resume: 'RESUMED',
  cancel: 'CANCELLED',
  suspend: 'SUSPENDED',
  liftHold: 'RESUMED',
  void: 'CANCELLED',
  reschedule: 'RESCHEDULED',
  reinstate: 'REINSTATED',
  openReview: 'ESCALATED',
  reviewHeld: 'REVIEW_DECIDED',
  reviewPostpone: 'REVIEW_DECIDED',
  reviewNoAction: 'REVIEW_DECIDED',
  reviewNoActionConfirmed: 'REVIEW_DECIDED',
};

/**
 * When a class under review changes this way, its open review is decided in the same transaction.
 * Starting the class does not decide it (CLASS_LIFECYCLE.md §4): the start shows in the review's
 * timeline and the administrator still decides.
 */
const REVIEW_DECISION: Partial<Record<ClassActionName, ReviewDecision>> = {
  reviewHeld: 'CLASS_HELD',
  reviewPostpone: 'POSTPONED',
  reviewNoAction: 'NO_ACTION',
  reviewNoActionConfirmed: 'NO_ACTION',
  cancel: 'CANCELLED',
  reschedule: 'RESCHEDULED',
  suspend: 'NO_ACTION',
};

const SYSTEM_EVENT: Record<SystemTransition, ClassEventType> = {
  markUnconfirmed: 'MARKED_UNCONFIRMED',
  escalate: 'ESCALATED',
  autoEnd: 'AUTO_ENDED',
};

const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
const MINUTE = 60_000;
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const SLOT_TAKEN = {
  class_sessions_room_no_overlap: { code: 'SLOT_TAKEN', message: 'The room is now booked at that time.' },
  class_sessions_lecturer_no_overlap: {
    code: 'SLOT_TAKEN',
    message: 'The lecturer now has another class at that time.',
  },
};

/**
 * The only code that changes a class's status (CLASS_LIFECYCLE.md §6). For each action it checks the
 * shared transition table, who is acting (the class's own lecturer, or an administrator within scope),
 * and the timing rules; then, in one transaction, it updates the session only if nobody changed it
 * first, and writes the class event and the audit entry. Students and course reps never change status.
 */
@Injectable()
export class ClassEventService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly access: AcademicAccessService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly clock: Clock,
  ) {}

  async act(
    actor: AccessClaims,
    sessionId: string,
    action: ClassActionName,
    input: ActionInput,
    context: RequestContext,
    inTransaction?: InTransaction,
  ) {
    if (action === 'reschedule' && !inTransaction) {
      throw new Error('A reschedule is applied only with its replacement session.');
    }
    const def = CLASS_ACTIONS[action];
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { sections: true },
    });
    if (!session) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    const capacity = await this.capacityFor(actor, session, action);
    const allowedFrom: readonly string[] = capacity === 'LECTURER' ? def.lecturerFrom : def.adminFrom;
    if (!allowedFrom.includes(session.status)) {
      throw conflict(
        'TRANSITION_NOT_ALLOWED',
        `"${def.label}" is not possible while the class is ${session.status.toLowerCase().replace('_', ' ')}.`,
      );
    }
    const now = this.clock.now();
    const data = this.changesFor(action, session, input, capacity, actor, now);

    await this.prisma
      .$transaction(async (tx) => {
        let extra: Record<string, Prisma.InputJsonValue> = {};
        if (inTransaction) {
          // The replacement may overlap the class it replaces; overlap rules are checked at commit.
          await tx.$executeRawUnsafe(
            'SET CONSTRAINTS "class_sessions_room_no_overlap", "class_sessions_lecturer_no_overlap" DEFERRED',
          );
          extra = await inTransaction(tx, session, now);
        }
        const claimed = await tx.classSession.updateMany({
          where: { id: session.id, status: session.status, version: session.version },
          data: { ...data, status: def.to, statusChangedAt: now, version: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          throw conflict(
            'STATUS_CHANGED',
            'Someone else changed this class a moment ago. Reload it and try again.',
          );
        }
        const decision = session.status === 'UNDER_REVIEW' ? REVIEW_DECISION[action] : undefined;
        if (decision) {
          const closed = await tx.classStatusReview.updateMany({
            where: { classSessionId: session.id, status: 'OPEN' },
            data: {
              status: 'DECIDED',
              decision,
              decisionNote:
                input.reviewNote ??
                `Decided by "${def.label}" (${capacity === 'LECTURER' ? 'lecturer' : 'administrator'}).`,
              decidedById: actor.userId,
              decidedAt: now,
            },
          });
          if (closed.count > 0) extra = { ...extra, reviewDecision: decision };
        }
        const payload = {
          as: capacity,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.minutes
            ? { minutes: input.minutes, expectedStart: (data.expectedStart as Date).toISOString() }
            : {}),
          ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(action === 'void' ? { voided: true } : {}),
          ...(action === 'liftHold' ? { holdLifted: true } : {}),
          ...extra,
        };
        await writeClassEvent(tx, this.outbox, {
          data: {
            classSessionId: session.id,
            type: EVENT[action],
            fromStatus: session.status,
            toStatus: def.to,
            actorType: 'USER',
            actorUserId: actor.userId,
            payload,
            occurredAt: now,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            `class_sessions.${action}`,
            { type: 'class_session', id: session.id },
            {
              before: { status: session.status },
              after: { status: def.to, ...payload },
              reason: input.reason ?? input.note,
            },
            context,
          ),
          tx,
        );
      })
      .catch((e: unknown) => rethrowAsConflict(e, SLOT_TAKEN));
  }

  /**
   * A change the server makes by itself (monitoring), on server time. Applied only if the class is
   * still exactly as the caller saw it (same status and version); otherwise nothing happens and this
   * returns false, because a person acting at the same moment wins. Recorded as a SYSTEM event.
   */
  async applySystem(
    session: ClassSession,
    transition: SystemTransition,
    payload: Record<string, Prisma.InputJsonValue>,
    inTransaction?: InTransaction,
  ): Promise<boolean> {
    const def = SYSTEM_TRANSITIONS[transition];
    if (!def.from.includes(session.status)) return false;
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.classSession.updateMany({
        where: { id: session.id, status: session.status, version: session.version },
        data: {
          status: def.to,
          statusChangedAt: now,
          version: { increment: 1 },
          ...(transition === 'autoEnd' ? { actualEnd: now } : {}),
        },
      });
      if (claimed.count !== 1) return false;
      const extra = inTransaction ? await inTransaction(tx, session, now) : {};
      await writeClassEvent(tx, this.outbox, {
        data: {
          classSessionId: session.id,
          type: SYSTEM_EVENT[transition],
          fromStatus: session.status,
          toStatus: def.to,
          actorType: 'SYSTEM',
          payload: { ...payload, ...extra },
          occurredAt: now,
        },
      });
      await this.audit.record(
        {
          action: `class_sessions.system.${transition}`,
          entityType: 'class_session',
          entityId: session.id,
          before: { status: session.status },
          after: { status: def.to, ...payload, ...extra },
        },
        tx,
      );
      return true;
    });
  }

  /**
   * Records that phones in the room could not hear its beacon during this class (no status change):
   * the class is in degraded mode from then on, so check-ins wait for the lecturer (PRESENCE_VERIFICATION
   * §6). Recorded once per class; returns false if it already was.
   */
  async recordBeaconDegraded(
    sessionId: string,
    payload: { beaconIds: string[]; devices: number; windowMinutes: number },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'degraded:' + sessionId}))`;
      const session = await tx.classSession.findUniqueOrThrow({ where: { id: sessionId } });
      const already = await tx.classEvent.count({
        where: { classSessionId: sessionId, type: 'BEACON_DEGRADED' },
      });
      if (already > 0) return false;
      await writeClassEvent(tx, this.outbox, {
        data: {
          classSessionId: sessionId,
          type: 'BEACON_DEGRADED',
          fromStatus: session.status,
          toStatus: session.status,
          actorType: 'SYSTEM',
          payload,
          occurredAt: this.clock.now(),
        },
      });
      return true;
    });
  }

  /**
   * Writes an attendance event in the attendance module's transaction (no status change), so the
   * class history shows when attendance opened, closed, reopened or was voided.
   */
  async recordAttendanceEvent(
    tx: Prisma.TransactionClient,
    sessionId: string,
    type: 'ATTENDANCE_OPENED' | 'ATTENDANCE_CLOSED' | 'ATTENDANCE_REOPENED' | 'ATTENDANCE_VOIDED',
    actorUserId: string | null,
    payload: Prisma.InputJsonValue,
    occurredAt: Date,
  ): Promise<void> {
    const session = await tx.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    await writeClassEvent(tx, this.outbox, {
      data: {
        classSessionId: sessionId,
        type,
        fromStatus: session.status,
        toStatus: session.status,
        actorType: actorUserId ? 'USER' : 'SYSTEM',
        actorUserId,
        payload,
        occurredAt,
      },
    });
  }

  /** Is this class in degraded mode (its room's beacon was not heard during it)? For check-in (Phase 5). */
  /**
   * When the class entered degraded mode, and the window of phone reports that showed the beacon
   * had failed (both as recorded at the time); null if it never did.
   */
  async beaconDegradedSince(sessionId: string): Promise<{ at: Date; evidenceFrom: Date } | null> {
    const event = await this.prisma.classEvent.findFirst({
      where: { classSessionId: sessionId, type: 'BEACON_DEGRADED' },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true, payload: true },
    });
    if (!event) return null;
    const minutes = Number((event.payload as { windowMinutes?: unknown } | null)?.windowMinutes ?? 0);
    return { at: event.occurredAt, evidenceFrom: new Date(event.occurredAt.getTime() - minutes * 60_000) };
  }

  async isBeaconDegraded(sessionId: string): Promise<boolean> {
    return (
      (await this.prisma.classEvent.count({
        where: { classSessionId: sessionId, type: 'BEACON_DEGRADED' },
      })) > 0
    );
  }

  /**
   * Records that the lecturer was nudged about a class (no status change). Returns false if they
   * already had been, so two checks at the same moment nudge once.
   */
  async recordPrompt(sessionId: string, reasons: string[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'prompt:' + sessionId}))`;
      const session = await tx.classSession.findUniqueOrThrow({ where: { id: sessionId } });
      const already = await tx.classEvent.count({
        where: { classSessionId: sessionId, type: { in: ['LECTURER_PROMPTED', 'MARKED_UNCONFIRMED'] } },
      });
      if (already > 0) return false;
      await writeClassEvent(tx, this.outbox, {
        data: {
          classSessionId: sessionId,
          type: 'LECTURER_PROMPTED',
          fromStatus: session.status,
          toStatus: session.status,
          actorType: 'SYSTEM',
          payload: { reasons },
          occurredAt: this.clock.now(),
        },
      });
      return true;
    });
  }

  /**
   * Is the actor acting as this class's own lecturer, or as an administrator within scope? Only the
   * assigned lecturer acts as "lecturer"; only Super Admins and University Administrators act as
   * administrators, and only for classes of sections within their faculty or department.
   */
  private async capacityFor(
    actor: AccessClaims,
    session: ClassSession & { sections: { sectionId: string }[] },
    action: ClassActionName,
  ) {
    const def = CLASS_ACTIONS[action] as (typeof CLASS_ACTIONS)[ClassActionName] & {
      lecturerPermission?: string;
      adminPermission?: string;
    };
    const held = await this.permissions.forRole(actor.role);
    if (actor.role === 'LECTURER') {
      const lecturerId = await this.lecturers.idForUser(actor.userId);
      if (lecturerId !== session.lecturerId) {
        throw new ForbiddenException({
          code: 'NOT_YOUR_CLASS',
          message: 'Only the lecturer of this class can do this.',
        });
      }
      if (def.lecturerFrom.length === 0 || !def.lecturerPermission || !held.has(def.lecturerPermission)) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'An administrator must do this.',
        });
      }
      return 'LECTURER' as const;
    }
    if (
      ADMIN_ROLES.includes(actor.role) &&
      def.adminFrom.length > 0 &&
      def.adminPermission &&
      held.has(def.adminPermission)
    ) {
      const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
      for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
      return 'ADMIN' as const;
    }
    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: 'You do not have permission to do this.',
    });
  }

  /** The extra fields each action sets, after checking its timing and input rules. */
  private changesFor(
    action: ClassActionName,
    session: ClassSession,
    input: ActionInput,
    capacity: 'LECTURER' | 'ADMIN',
    actor: AccessClaims,
    now: Date,
  ): Prisma.ClassSessionUncheckedUpdateManyInput {
    const start = session.scheduledStart.getTime();
    const end = session.scheduledEnd.getTime();
    switch (action) {
      case 'start':
        if (
          now.getTime() < start - LIFECYCLE_TIMING.startOpensBeforeMinutes * MINUTE ||
          now.getTime() >= end
        ) {
          throw conflict(
            'OUTSIDE_START_WINDOW',
            `A class can be started from ${LIFECYCLE_TIMING.startOpensBeforeMinutes} minutes before its start until its scheduled end.`,
          );
        }
        return { actualStart: now };
      case 'reviewHeld':
        if (now.getTime() < start) {
          throw conflict('TOO_EARLY', 'A class cannot be decided as held before its scheduled start.');
        }
        return {};
      case 'reviewPostpone':
      case 'delay': {
        const expected = new Date(start + input.minutes! * MINUTE);
        if (expected.getTime() <= now.getTime()) {
          throw conflict('DELAY_IN_PAST', 'The new expected start must be in the future.');
        }
        if (expected.getTime() > end - LIFECYCLE_TIMING.minimumRemainingAfterDelayMinutes * MINUTE) {
          throw conflict(
            'DELAY_TOO_LONG',
            `A delayed class must still leave ${LIFECYCLE_TIMING.minimumRemainingAfterDelayMinutes} minutes before its scheduled end. Cancel or reschedule it instead.`,
          );
        }
        return { expectedStart: expected };
      }
      case 'end':
        return { actualEnd: now };
      case 'resume':
      case 'liftHold':
        if (now.getTime() >= end) throw conflict('TOO_LATE', 'The scheduled end of this class has passed.');
        return {};
      case 'cancel':
        if (
          capacity === 'LECTURER' &&
          (ADMIN_ONLY_CANCEL_REASONS as readonly string[]).includes(input.reasonCode!)
        ) {
          throw new ForbiddenException({
            code: 'ADMIN_ONLY_REASON',
            message: 'Only an administrator can record that reason.',
          });
        }
        return {
          cancelReason: input.reasonCode!,
          cancelNote: input.note ?? null,
          cancelledById: actor.userId,
        };
      case 'void':
        return {
          cancelReason: input.reasonCode ?? 'OTHER',
          cancelNote: input.reason!,
          cancelledById: actor.userId,
        };
      case 'reinstate':
        if (now.getTime() >= end) throw conflict('TOO_LATE', 'The scheduled end of this class has passed.');
        if (session.actualStart) {
          throw conflict(
            'CANNOT_REINSTATE_VOIDED',
            'This class had started and was voided; it cannot be reinstated.',
          );
        }
        return { cancelReason: null, cancelNote: null, cancelledById: null, expectedStart: null };
      default:
        return {};
    }
  }
}
