import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVIDENCE_ISSUE_TYPES, SYSTEM_TRANSITIONS } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { ClassSession, ClassStatus, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ClassEventService } from './class-event.service.js';
import { evaluate, type Thresholds, type Verdict } from './detection-engine.js';

const MINUTE = 60_000;
/** How often the sweep runs. */
export const SWEEP_EVERY_MS = 60_000;
/** The sweep looks back this far, so a class missed while the system was down is still handled. */
const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * MINUTE;
const WATCHED = SYSTEM_TRANSITIONS.escalate.from as ClassStatus[];

/**
 * Watches classes (CLASS_MONITORING.md). A sweep every minute finds classes past their checkpoints;
 * each new report triggers a check of its class at once. Both use the same evaluation, so whichever
 * runs first does the work and the other finds nothing to do. The detection engine decides; this
 * service gathers the evidence and applies the result through ClassEventService.
 */
@Injectable()
export class ClassMonitorService implements OnModuleInit {
  private readonly logger = new Logger(ClassMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRegistry,
    private readonly events: ClassEventService,
    private readonly enrollments: EnrollmentsService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.define<{ sessionId: string }>({
      queue: 'monitoring',
      name: 'evaluate',
      attempts: 5,
      handle: async (data) => {
        await this.evaluateSession(data.sessionId);
      },
    });
    this.jobs.define({
      queue: 'monitoring',
      name: 'sweep',
      attempts: 3,
      handle: async () => {
        await this.sweep();
      },
    });
    this.jobs.every('monitoring', 'sweep', SWEEP_EVERY_MS);
  }

  /** Checks every watched class whose first checkpoint has passed. */
  async sweep(): Promise<{ checked: number; changed: number }> {
    const now = this.clock.now();
    const t = await this.thresholds();
    const due = await this.prisma.classSession.findMany({
      where: {
        status: { in: WATCHED },
        scheduledStart: {
          lte: new Date(now.getTime() - t.unconfirmedAfterMinutes * MINUTE),
          gte: new Date(now.getTime() - SWEEP_LOOKBACK_MS),
        },
      },
      select: { id: true },
      orderBy: { scheduledStart: 'asc' },
      take: 1000,
    });
    let changed = 0;
    for (const { id } of due) {
      const result = await this.evaluateSession(id, t);
      if (result.applied) changed += 1;
    }
    if (changed > 0) this.logger.log(`Monitoring sweep: ${due.length} checked, ${changed} changed.`);
    return { checked: due.length, changed };
  }

  /** Gathers the evidence for one class, asks the engine, and applies its recommendation. */
  async evaluateSession(sessionId: string, given?: Thresholds): Promise<Verdict & { applied: boolean }> {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { sections: true },
    });
    if (!session) return { recommendation: 'NONE', priority: false, reasons: [], applied: false };
    const t = given ?? (await this.thresholds());
    const verdict = evaluate(await this.evidence(session), t);
    const payload = { reasons: verdict.reasons, priority: verdict.priority };
    let applied = false;
    switch (verdict.recommendation) {
      case 'NOTIFY_LECTURER':
        applied = await this.events.recordPrompt(session.id, verdict.reasons);
        break;
      case 'MARK_UNCONFIRMED':
        applied = await this.events.applySystem(session, 'markUnconfirmed', payload);
        break;
      case 'ESCALATE_TO_REVIEW':
        applied = await this.events.applySystem(session, 'escalate', payload, (tx, _s, now) =>
          this.openReview(tx, session.id, 'SYSTEM_ESCALATION', verdict.priority, verdict.reasons, now),
        );
        break;
      case 'NONE':
        break;
    }
    return { ...verdict, applied };
  }

  /**
   * An administrator refers a class to review (the "open review" action), which also opens a review
   * record for the review queue.
   */
  async adminOpenReview(actor: AccessClaims, sessionId: string, reason: string, context: RequestContext) {
    await this.events.act(actor, sessionId, 'openReview', { reason }, context, (tx, _s, now) =>
      this.openReview(tx, sessionId, 'ADMIN_OPENED', false, [reason], now),
    );
  }

  private async openReview(
    tx: Prisma.TransactionClient,
    sessionId: string,
    trigger: 'SYSTEM_ESCALATION' | 'ADMIN_OPENED',
    isPriority: boolean,
    reasons: string[],
    now: Date,
  ) {
    const review = await tx.classStatusReview.create({
      data: { classSessionId: sessionId, trigger, isPriority, reasons, openedAt: now },
    });
    return { reviewId: review.id };
  }

  private async evidence(session: ClassSession & { sections: { sectionId: string }[] }) {
    const now = this.clock.now();
    const start = session.expectedStart ?? session.scheduledStart;
    const [reports, lecturerReports, pendingReschedules, prompts, enrolled] = await Promise.all([
      this.prisma.classIssueReport.findMany({
        where: {
          classSessionId: session.id,
          type: { in: [...EVIDENCE_ISSUE_TYPES] },
          reporterRole: { in: ['STUDENT', 'COURSE_REP'] },
          status: { not: 'DISMISSED' },
        },
        select: { reporterUserId: true, reporterRole: true, type: true },
      }),
      this.prisma.classIssueReport.count({ where: { classSessionId: session.id, reporterRole: 'LECTURER' } }),
      this.prisma.rescheduleRequest.count({ where: { classSessionId: session.id, status: 'PENDING' } }),
      this.prisma.classEvent.count({
        where: { classSessionId: session.id, type: { in: ['LECTURER_PROMPTED', 'MARKED_UNCONFIRMED'] } },
      }),
      this.enrollments.enrolledBySection(session.sections.map((s) => s.sectionId)),
    ]);
    const reporters = new Set(reports.map((r) => r.reporterUserId));
    const reps = new Set(reports.filter((r) => r.reporterRole === 'COURSE_REP').map((r) => r.reporterUserId));
    return {
      status: session.status,
      minutesSinceStart: Math.floor((now.getTime() - start.getTime()) / MINUTE),
      lecturerActed: lecturerReports > 0 || pendingReschedules > 0,
      lecturerPrompted: prompts > 0,
      studentReporters: reporters.size,
      repReporters: reps.size,
      verbalCancellation: reports.some((r) => r.type === 'VERBAL_CANCELLATION'),
      enrolled: new Set([...enrolled.values()].flat()).size,
    };
  }

  private async thresholds(): Promise<Thresholds> {
    const [unconfirmed, review, minStudents, minPercent, corroborating] = await Promise.all([
      this.settings.get('monitoring.unconfirmedAfterMinutes'),
      this.settings.get('monitoring.reviewAfterMinutes'),
      this.settings.get('monitoring.reportMinStudents'),
      this.settings.get('monitoring.reportMinPercent'),
      this.settings.get('monitoring.repCorroboratingStudents'),
    ]);
    return {
      unconfirmedAfterMinutes: unconfirmed,
      reviewAfterMinutes: review,
      reportMinStudents: minStudents,
      reportMinPercent: minPercent,
      repCorroboratingStudents: corroborating,
    };
  }
}
