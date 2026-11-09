import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type IssueType, REPORT_RULES } from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import type {
  ClassIssueReport,
  ClassSession,
  ClassStatus,
  ReporterRole,
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
import { CourseRepsService } from '../enrollments/course-reps.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { StudentsService } from '../students/students.service.js';

const MINUTE = 60_000;
/** Reports are taken until the class is over: not for completed, cancelled or rescheduled classes. */
const CLOSED: ClassStatus[] = ['COMPLETED', 'CANCELLED', 'RESCHEDULED'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
type SessionWithSections = ClassSession & { sections: { sectionId: string }[] };
const limit = (message: string) => new ConflictException({ code: 'REPORT_LIMIT', message });

/**
 * Problems with a class reported by the people in it (CLASS_MONITORING.md §2): enrolled students,
 * the section's course rep, and the class's lecturer. A report is evidence only. It is saved together
 * with a job that re-checks the class at once, so the check happens if and only if the report is saved.
 */
@Injectable()
export class IssueReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly permissions: PermissionService,
    private readonly access: AcademicAccessService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
    private readonly reps: CourseRepsService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async report(
    actor: AccessClaims,
    sessionId: string,
    input: { type: IssueType; note?: string },
    context: RequestContext,
  ) {
    const session = await this.session(sessionId);
    const reporterRole = await this.reporterRole(actor, session);
    this.assertWindow(session, input.type);
    const now = this.clock.now();

    const row = await this.prisma
      .$transaction(async (tx) => {
        if (reporterRole !== 'LECTURER') {
          // One person's reports are counted one at a time, so simultaneous reports cannot exceed the limits.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'reports:' + actor.userId}))`;
          const forClass = await tx.classIssueReport.count({
            where: { classSessionId: session.id, reporterUserId: actor.userId },
          });
          if (forClass >= REPORT_RULES.maxPerClass) {
            throw limit(`You can report at most ${REPORT_RULES.maxPerClass} problems for one class.`);
          }
          const tz = this.config.institutionTimezone;
          const today = wallClockToUtc(dayIn(now, tz), 0, tz);
          const forDay = await tx.classIssueReport.count({
            where: { reporterUserId: actor.userId, createdAt: { gte: today } },
          });
          if (forDay >= REPORT_RULES.maxPerDay) {
            throw limit(`You can report at most ${REPORT_RULES.maxPerDay} problems a day.`);
          }
        }
        const created = await tx.classIssueReport.create({
          data: {
            classSessionId: session.id,
            reporterUserId: actor.userId,
            reporterRole,
            type: input.type,
            note: input.note ?? null,
            createdAt: now,
          },
        });
        await tx.classEvent.create({
          data: {
            classSessionId: session.id,
            type: 'ISSUE_REPORTED',
            fromStatus: session.status,
            toStatus: session.status,
            actorType: 'USER',
            actorUserId: actor.userId,
            payload: { reportId: created.id, type: input.type, reporterRole },
            occurredAt: now,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'class_issue_reports.created',
            { type: 'class_issue_report', id: created.id },
            { after: { classSessionId: session.id, type: input.type, reporterRole } },
            context,
          ),
          tx,
        );
        await this.outbox.add(tx, 'monitoring', 'evaluate', { sessionId: session.id });
        return created;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: {
            code: 'DUPLICATE_REPORT',
            message: 'You have already reported this problem for this class.',
          },
        }),
      );
    return this.view(row, true);
  }

  /**
   * Reports for one class. The lecturer of the class and administrators within scope see all of them;
   * the lecturer sees who reported only as "student" or "course rep", never the name, so nobody is
   * discouraged from reporting. Anyone else sees only their own reports.
   */
  async list(actor: AccessClaims, sessionId: string) {
    const session = await this.session(sessionId);
    const rows = await this.prisma.classIssueReport.findMany({
      where: { classSessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    if (await this.isAdminInScope(actor, session)) return { data: rows.map((r) => this.view(r, true)) };
    if (actor.role === 'LECTURER' && (await this.lecturers.idForUser(actor.userId)) === session.lecturerId) {
      return { data: rows.map((r) => this.view(r, r.reporterUserId === actor.userId)) };
    }
    return { data: rows.filter((r) => r.reporterUserId === actor.userId).map((r) => this.view(r, true)) };
  }

  /** The class's lecturer reports as LECTURER; an enrolled student as STUDENT, or COURSE_REP if they are its rep. */
  private async reporterRole(actor: AccessClaims, session: SessionWithSections): Promise<ReporterRole> {
    const sectionIds = session.sections.map((s) => s.sectionId);
    if (actor.role === 'LECTURER') {
      if ((await this.lecturers.idForUser(actor.userId)) === session.lecturerId) return 'LECTURER';
      throw new ForbiddenException({
        code: 'NOT_YOUR_CLASS',
        message: 'Only the lecturer of this class can do this.',
      });
    }
    if (actor.role === 'STUDENT') {
      const studentId = await this.students.idForUser(actor.userId);
      if (studentId) {
        const enrolled = await Promise.all(
          sectionIds.map((id) => this.enrollments.isEnrolled(studentId, id)),
        );
        if (enrolled.some(Boolean)) {
          const repOf = await this.reps.activeRepSectionIds(studentId, sectionIds);
          return repOf.length > 0 ? 'COURSE_REP' : 'STUDENT';
        }
      }
      throw new ForbiddenException({
        code: 'NOT_IN_CLASS',
        message: 'Only students enrolled in this class can report a problem with it.',
      });
    }
    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: 'Only the class’s students, course rep and lecturer report problems.',
    });
  }

  private assertWindow(session: ClassSession, type: IssueType) {
    if (CLOSED.includes(session.status)) {
      throw new ConflictException({
        code: 'CLASS_CLOSED',
        message: `This class is ${session.status.toLowerCase()}; problems can no longer be reported.`,
      });
    }
    const now = this.clock.now().getTime();
    const start = (session.expectedStart ?? session.scheduledStart).getTime();
    const opens =
      type === 'LECTURER_NOT_ARRIVED'
        ? start + REPORT_RULES.notArrivedAfterMinutes * MINUTE
        : start - REPORT_RULES.opensBeforeMinutes * MINUTE;
    if (now < opens || now >= session.scheduledEnd.getTime()) {
      throw new ConflictException({
        code: 'OUTSIDE_REPORT_WINDOW',
        message:
          type === 'LECTURER_NOT_ARRIVED'
            ? `"Lecturer has not arrived" can be reported from ${REPORT_RULES.notArrivedAfterMinutes} minutes after the start until the scheduled end.`
            : `Problems can be reported from ${REPORT_RULES.opensBeforeMinutes} minutes before the start until the scheduled end.`,
      });
    }
  }

  private async isAdminInScope(actor: AccessClaims, session: SessionWithSections) {
    if (!ADMIN_ROLES.includes(actor.role)) return false;
    if (!(await this.permissions.forRole(actor.role)).has('class_reviews.decide')) return false;
    const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
    for (const s of sections.values()) if (!(await this.access.covers(actor, s.department))) return false;
    return true;
  }

  private async session(id: string): Promise<SessionWithSections> {
    const row = await this.prisma.classSession.findUnique({ where: { id }, include: { sections: true } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    return row;
  }

  private view(r: ClassIssueReport, showReporter: boolean) {
    return {
      id: r.id,
      classSessionId: r.classSessionId,
      type: r.type,
      note: r.note,
      reporterRole: r.reporterRole,
      reporterUserId: showReporter ? r.reporterUserId : null,
      status: r.status,
      createdAt: r.createdAt,
    };
  }
}
