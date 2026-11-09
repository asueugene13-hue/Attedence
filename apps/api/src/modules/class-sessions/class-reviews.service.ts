import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DecideReviewSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import type { ClassSession, ClassStatusReview, ReviewStatus } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ClassEventService } from './class-event.service.js';
import { ClassSessionsService } from './class-sessions.service.js';
import { RescheduleService } from './reschedule.service.js';

type Decision = z.output<typeof DecideReviewSchema>;
type SessionWithSections = ClassSession & { sections: { sectionId: string }[] };

const MINUTE = 60_000;
const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
/** Statuses of a class that started after its review was opened: only "the class was held" fits. */
const STARTED = ['ACTIVE', 'INTERRUPTED', 'COMPLETED'];
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such review.' });
const alreadyDecided = () =>
  new ConflictException({ code: 'ALREADY_DECIDED', message: 'This review has already been decided.' });

/**
 * The administrator review queue (CLASS_MONITORING.md §7). A decision on a class still under review
 * is a status change through ClassEventService, which decides the review in the same transaction.
 * A class whose lecturer started it after the review opened can only be decided "held", which closes
 * the review without changing the class.
 */
@Injectable()
export class ClassReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ClassEventService,
    private readonly reschedules: RescheduleService,
    private readonly sessions: ClassSessionsService,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionService,
    private readonly access: AcademicAccessService,
    private readonly courses: CoursesService,
    private readonly clock: Clock,
  ) {}

  /** Reviews for classes within the administrator's scope: priority first, then the oldest. */
  async list(actor: AccessClaims, status: ReviewStatus) {
    await this.assertDecider(actor);
    const rows = await this.prisma.classStatusReview.findMany({
      where: { status },
      include: { classSession: { include: { sections: true } } },
      orderBy: status === 'OPEN' ? [{ isPriority: 'desc' }, { openedAt: 'asc' }] : [{ decidedAt: 'desc' }],
      take: 500,
    });
    const visible: typeof rows = [];
    for (const row of rows) if (await this.covers(actor, row.classSession)) visible.push(row);
    const counts = await this.prisma.classIssueReport.groupBy({
      by: ['classSessionId', 'type'],
      where: { classSessionId: { in: visible.map((r) => r.classSessionId) }, status: { not: 'DISMISSED' } },
      _count: { _all: true },
    });
    const sessions = await this.sessions.summaries(visible.map((r) => r.classSessionId));
    return {
      data: visible.map((r) => ({
        ...this.view(r),
        classSession: sessions.get(r.classSessionId) ?? null,
        reportCounts: Object.fromEntries(
          counts.filter((c) => c.classSessionId === r.classSessionId).map((c) => [c.type, c._count._all]),
        ),
      })),
    };
  }

  /** One review with what the reviewer needs: the class, its full timeline and every report. */
  async get(actor: AccessClaims, id: string) {
    const review = await this.find(id);
    await this.assertDecider(actor, review.classSession);
    const [session, reports] = await Promise.all([
      this.sessions.get(review.classSessionId),
      this.prisma.classIssueReport.findMany({
        where: { classSessionId: review.classSessionId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      ...this.view(review),
      classSession: session,
      reports: reports.map((r) => ({
        id: r.id,
        type: r.type,
        note: r.note,
        reporterRole: r.reporterRole,
        reporterUserId: r.reporterUserId,
        status: r.status,
        createdAt: r.createdAt,
      })),
    };
  }

  async decide(actor: AccessClaims, id: string, input: Decision, context: RequestContext) {
    const review = await this.find(id);
    if (review.status !== 'OPEN') throw alreadyDecided();
    const session = review.classSession;
    await this.assertDecider(actor, session);

    if (STARTED.includes(session.status)) {
      if (input.decision !== 'CLASS_HELD') {
        throw new ConflictException({
          code: 'CLASS_STARTED',
          message: 'The lecturer started this class after the review opened; it can only be decided as held.',
        });
      }
      await this.closeWithoutChange(actor, review, input.note, context);
      return this.get(actor, id);
    }
    if (session.status !== 'UNDER_REVIEW') {
      throw new ConflictException({
        code: 'TRANSITION_NOT_ALLOWED',
        message: `The class is ${session.status.toLowerCase().replace('_', ' ')}, so this review cannot be decided this way.`,
      });
    }

    const reviewNote = input.note;
    switch (input.decision) {
      case 'CLASS_HELD':
        await this.events.act(actor, session.id, 'reviewHeld', { reason: input.note, reviewNote }, context);
        break;
      case 'CANCELLED':
        await this.events.act(
          actor,
          session.id,
          'cancel',
          { reasonCode: input.reasonCode, note: input.note, reviewNote },
          context,
        );
        break;
      case 'POSTPONED':
        await this.events.act(
          actor,
          session.id,
          'reviewPostpone',
          { minutes: input.minutes, reason: input.note, reviewNote },
          context,
        );
        break;
      case 'NO_ACTION':
        await this.assertNoActionInTime(session);
        await this.events.act(
          actor,
          session.id,
          (await this.wasConfirmed(session.id)) ? 'reviewNoActionConfirmed' : 'reviewNoAction',
          { reason: input.note, reviewNote },
          context,
        );
        break;
      case 'RESCHEDULED':
        await this.reschedules.direct(
          actor,
          session.id,
          { ...input.reschedule, reason: input.note },
          context,
          reviewNote,
        );
        break;
    }
    return this.get(actor, id);
  }

  /** "No action needed" only before the unconfirmed checkpoint (CLASS_LIFECYCLE.md §4). */
  private async assertNoActionInTime(session: ClassSession) {
    const minutes = await this.settings.get('monitoring.unconfirmedAfterMinutes');
    const start = (session.expectedStart ?? session.scheduledStart).getTime();
    if (this.clock.now().getTime() >= start + minutes * MINUTE) {
      throw new ConflictException({
        code: 'TOO_LATE_FOR_NO_ACTION',
        message: `"No action needed" is possible only until ${minutes} minutes after the start. Choose another decision.`,
      });
    }
  }

  private async wasConfirmed(sessionId: string) {
    return (
      (await this.prisma.classEvent.count({ where: { classSessionId: sessionId, type: 'CONFIRMED' } })) > 0
    );
  }

  private async closeWithoutChange(
    actor: AccessClaims,
    review: ClassStatusReview,
    note: string,
    context: RequestContext,
  ) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.classStatusReview.updateMany({
        where: { id: review.id, status: 'OPEN' },
        data: {
          status: 'DECIDED',
          decision: 'CLASS_HELD',
          decisionNote: note,
          decidedById: actor.userId,
          decidedAt: now,
        },
      });
      if (done.count !== 1) throw alreadyDecided();
      await this.audit.record(
        auditEntry(
          actor,
          'class_reviews.decided',
          { type: 'class_status_review', id: review.id },
          { before: { status: 'OPEN' }, after: { status: 'DECIDED', decision: 'CLASS_HELD' }, reason: note },
          context,
        ),
        tx,
      );
    });
  }

  /** An administrator who may decide reviews and, for a given class, whose scope covers it. */
  private async assertDecider(actor: AccessClaims, session?: SessionWithSections) {
    const may =
      ADMIN_ROLES.includes(actor.role) &&
      (await this.permissions.forRole(actor.role)).has('class_reviews.decide');
    if (!may) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });
    }
    if (session) {
      const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
      for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
    }
  }

  private async covers(actor: AccessClaims, session: SessionWithSections) {
    const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
    for (const s of sections.values()) if (!(await this.access.covers(actor, s.department))) return false;
    return true;
  }

  private async find(id: string) {
    const row = await this.prisma.classStatusReview.findUnique({
      where: { id },
      include: { classSession: { include: { sections: true } } },
    });
    if (!row) throw notFound();
    return row;
  }

  private view(r: ClassStatusReview) {
    return {
      id: r.id,
      classSessionId: r.classSessionId,
      trigger: r.trigger,
      isPriority: r.isPriority,
      reasons: r.reasons,
      openedAt: r.openedAt,
      status: r.status,
      decision: r.decision,
      decisionNote: r.decisionNote,
      decidedById: r.decidedById,
      decidedAt: r.decidedAt,
    };
  }
}
