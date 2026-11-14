import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type ExportRequest, REPORT_LABELS, type ReportType } from '@attendsure/shared';
import { AppConfig } from '../../config/app-config.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import { AttendanceAnalyticsService } from '../attendance/attendance-analytics.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { AttendanceSummaryService } from '../attendance/attendance-summary.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { ClassAnalyticsService } from '../class-sessions/class-analytics.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';

export type Cell = string | number | null;
export interface Report {
  title: string;
  subtitle: string;
  columns: { label: string; width?: number }[];
  rows: Cell[][];
  /** Wide reports (registers) are laid out landscape in PDF. */
  wide?: boolean;
}

/** The permission each report needs; reports naming people also need `reports.export_personal`. */
const NEEDS: Record<ReportType, string> = {
  SECTION_SUMMARY: 'reports.course',
  SECTION_REGISTER: 'reports.course',
  ATTENDANCE_ANALYTICS: 'analytics.read',
  CLASS_OPERATIONS: 'analytics.read',
  STUDENT_ENROLMENTS: 'reports.registrar',
  AUDIT_LOG: 'audit_logs.read',
};

/** Whether a report names people (students or lecturers): such files are personal data (Act 843). */
export function containsPersonalData(request: ExportRequest): boolean {
  switch (request.reportType) {
    case 'ATTENDANCE_ANALYTICS':
    case 'CLASS_OPERATIONS':
      return request.params.groupBy === 'lecturer';
    default:
      return true;
  }
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/**
 * Builds report tables from the modules that own the data, with the requester's own access: each
 * source checks role, permission and scope itself (CLAUDE.md rule 8), so a report never shows more
 * than the same person sees on screen.
 */
@Injectable()
export class ReportBuilder {
  constructor(
    private readonly config: AppConfig,
    private readonly permissions: PermissionService,
    private readonly lookups: AcademicLookupsService,
    private readonly summaries: AttendanceSummaryService,
    private readonly attendance: AttendanceAnalyticsService,
    private readonly classes: ClassAnalyticsService,
    private readonly enrollments: EnrollmentsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Checks the permissions a report needs (scope is checked by its source when it is built). */
  async assertAllowed(actor: AccessClaims, request: ExportRequest): Promise<void> {
    const held = await this.permissions.forRole(actor.role);
    if (!held.has(NEEDS[request.reportType])) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot make this report.' });
    }
    if (containsPersonalData(request) && !held.has('reports.export_personal')) {
      throw new ForbiddenException({
        code: 'PERSONAL_DATA_EXPORT_DENIED',
        message: 'This report names people, and you cannot export personal data.',
      });
    }
  }

  /**
   * The cheap checks, when the file is asked for, so a refusal is immediate rather than a failed file
   * later: the section is the caller's to see, analytics are for administrators, the semester exists.
   */
  async preflight(actor: AccessClaims, request: ExportRequest): Promise<void> {
    switch (request.reportType) {
      case 'SECTION_SUMMARY':
      case 'SECTION_REGISTER':
        await this.summaries.authorizeSection(actor, request.params.sectionId);
        return;
      case 'ATTENDANCE_ANALYTICS':
      case 'CLASS_OPERATIONS':
        if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
          throw new ForbiddenException({
            code: 'PERMISSION_DENIED',
            message: 'Analytics are for administrators.',
          });
        }
        await this.semester(request.params.semesterId);
        return;
      case 'STUDENT_ENROLMENTS':
        await this.semester(request.params.semesterId);
        return;
      case 'AUDIT_LOG':
        await this.auditLogs.assertCanRead(actor);
        return;
    }
  }

  async build(actor: AccessClaims, request: ExportRequest): Promise<Report> {
    await this.assertAllowed(actor, request);
    switch (request.reportType) {
      case 'SECTION_SUMMARY':
        return this.sectionSummary(actor, request.params.sectionId);
      case 'SECTION_REGISTER':
        return this.sectionRegister(actor, request.params.sectionId);
      case 'ATTENDANCE_ANALYTICS':
        return this.attendanceAnalytics(actor, request.params.semesterId, request.params.groupBy);
      case 'CLASS_OPERATIONS':
        return this.classOperations(actor, request.params.semesterId, request.params.groupBy);
      case 'STUDENT_ENROLMENTS':
        return this.studentEnrolments(request.params.semesterId);
      case 'AUDIT_LOG':
        return this.auditLog(actor, request.params);
    }
  }

  private async sectionSummary(actor: AccessClaims, sectionId: string): Promise<Report> {
    const s = await this.summaries.section(actor, sectionId);
    return {
      title: `${REPORT_LABELS.SECTION_SUMMARY}: ${s.section.course.code} · ${s.section.code}`,
      subtitle: `${s.section.course.title} · ${s.section.semester.name} · ${s.classesHeld} classes held · late counts as ${s.lateWeight} · ${s.minimumPercent === null ? 'no minimum set' : `minimum ${s.minimumPercent}%`}`,
      columns: [
        { label: 'Student ID', width: 12 },
        { label: 'Name', width: 28 },
        { label: 'Enrolled', width: 9 },
        { label: 'Counted', width: 9 },
        { label: 'Present', width: 9 },
        { label: 'Late', width: 7 },
        { label: 'Absences', width: 9 },
        { label: 'Excused', width: 9 },
        { label: 'Undecided', width: 10 },
        { label: 'Cancelled', width: 10 },
        { label: 'Attendance', width: 11 },
      ],
      rows: s.data.map((l) => [
        l.studentNumber,
        l.fullName,
        l.enrolled ? 'Yes' : 'No (ended)',
        l.eligible,
        l.present,
        l.late,
        l.absences,
        l.excused,
        l.undecided,
        l.cancelled,
        pct(l.percentage),
      ]),
    };
  }

  private async sectionRegister(actor: AccessClaims, sectionId: string): Promise<Report> {
    const r = await this.summaries.sectionRegister(actor, sectionId);
    const day = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.config.institutionTimezone,
      day: 'numeric',
      month: 'short',
    });
    return {
      title: `${REPORT_LABELS.SECTION_REGISTER}: ${r.section.course.code} · ${r.section.code}`,
      subtitle: `${r.section.course.title} · ${r.section.semester.name} · P present, L late, A absent, R rejected, E excused, W waiting for a decision, V voided, — not enrolled yet`,
      wide: true,
      columns: [
        { label: 'Student ID', width: 12 },
        { label: 'Name', width: 26 },
        ...r.classes.map((c) => ({ label: day.format(c.scheduledStart), width: 6 })),
        { label: 'Attendance', width: 15 },
      ],
      rows: r.data.map((l) => [l.studentNumber, l.fullName, ...l.cells, pct(l.percentage)]),
    };
  }

  private async attendanceAnalytics(
    actor: AccessClaims,
    semesterId: string | undefined,
    groupBy: Parameters<AttendanceAnalyticsService['attendance']>[2],
  ): Promise<Report> {
    const a = await this.attendance.attendance(actor, semesterId, groupBy);
    return {
      title: `${REPORT_LABELS.ATTENDANCE_ANALYTICS} by ${groupBy}`,
      subtitle: `${a.semester.name} · late counts as ${a.lateWeight} · ${a.minimumPercent === null ? 'no minimum set' : `minimum ${a.minimumPercent}%`} · overall ${pct(a.totals.percentage)}`,
      columns: [
        { label: groupBy[0]!.toUpperCase() + groupBy.slice(1), width: 34 },
        { label: 'Students', width: 9 },
        { label: 'Present', width: 9 },
        { label: 'Late', width: 7 },
        { label: 'Absences', width: 9 },
        { label: 'Excused', width: 9 },
        { label: 'Undecided', width: 10 },
        { label: 'Attendance', width: 11 },
        { label: 'Below minimum', width: 13 },
      ],
      rows: a.rows.map((r) => [
        r.label,
        r.students,
        r.present,
        r.late,
        r.absences,
        r.excused,
        r.undecided,
        pct(r.percentage),
        r.belowMinimum ?? '—',
      ]),
    };
  }

  private async classOperations(
    actor: AccessClaims,
    semesterId: string | undefined,
    groupBy: Parameters<ClassAnalyticsService['classes']>[2],
  ): Promise<Report> {
    const c = await this.classes.classes(actor, semesterId, groupBy);
    return {
      title: `${REPORT_LABELS.CLASS_OPERATIONS} by ${groupBy}`,
      subtitle: c.semester.name,
      wide: true,
      columns: [
        { label: groupBy[0]!.toUpperCase() + groupBy.slice(1), width: 34 },
        { label: 'Scheduled', width: 10 },
        { label: 'Held', width: 7 },
        { label: 'Cancelled', width: 10 },
        { label: 'Rescheduled', width: 12 },
        { label: 'Suspended', width: 10 },
        { label: 'Still to come', width: 12 },
        { label: 'Delay reported', width: 13 },
        { label: 'Unconfirmed', width: 12 },
        { label: 'Reviewed', width: 9 },
        { label: 'Average late start (min)', width: 14 },
      ],
      rows: c.rows.map((r) => [
        r.label,
        r.scheduled,
        r.held,
        r.cancelled,
        r.rescheduled,
        r.suspended,
        r.stillToCome,
        r.delayed,
        r.unconfirmed,
        r.reviewed,
        r.averageLateStartMinutes ?? '—',
      ]),
    };
  }

  private async auditLog(
    actor: AccessClaims,
    filters: Parameters<AuditLogsService['forExport']>[1],
  ): Promise<Report> {
    const { rows, truncated } = await this.auditLogs.forExport(actor, filters);
    const when = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.config.institutionTimezone,
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
    const described = Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ');
    return {
      title: REPORT_LABELS.AUDIT_LOG,
      subtitle: `${described ? `Filtered by ${described}. ` : 'Everything. '}Newest first.${truncated ? ' Only the newest 20,000 entries: narrow the dates for more.' : ''}`,
      wide: true,
      columns: [
        { label: 'When', width: 18 },
        { label: 'Who', width: 22 },
        { label: 'Role', width: 14 },
        { label: 'Action', width: 26 },
        { label: 'Record', width: 18 },
        { label: 'Record ID', width: 26 },
        { label: 'Reason', width: 30 },
        { label: 'IP address', width: 14 },
      ],
      rows: rows.map((a) => [
        when.format(a.occurredAt),
        a.actor
          ? `${a.actor.fullName} <${a.actor.email}>`
          : a.actorType === 'SYSTEM'
            ? 'The system'
            : a.actorType,
        a.actorRoleKey ?? '',
        a.action,
        a.entityType,
        a.entityId ?? '',
        a.reason ?? '',
        a.ip ?? '',
      ]),
    };
  }

  private async semester(semesterId: string | undefined) {
    const id = semesterId ?? (await this.lookups.currentSemesterId());
    const semester = id ? await this.lookups.semester(id) : null;
    if (!semester) {
      throw new NotFoundException({
        code: semesterId ? 'NOT_FOUND' : 'NO_ACTIVE_SEMESTER',
        message: semesterId ? 'No such semester.' : 'There is no active semester; choose one.',
      });
    }
    return semester;
  }

  private async studentEnrolments(semesterId: string | undefined): Promise<Report> {
    const semester = await this.semester(semesterId);
    const rows = await this.enrollments.semesterReport(semester.id);
    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    return {
      title: `${REPORT_LABELS.STUDENT_ENROLMENTS}: ${semester.name}`,
      subtitle: 'Every enrolment in the semester’s courses, current and ended.',
      wide: true,
      columns: [
        { label: 'Student ID', width: 12 },
        { label: 'Name', width: 26 },
        { label: 'Programme', width: 11 },
        { label: 'Level', width: 7 },
        { label: 'Student status', width: 13 },
        { label: 'Course', width: 30 },
        { label: 'Section', width: 8 },
        { label: 'Enrolment', width: 10 },
        { label: 'Enrolled', width: 11 },
        { label: 'Ended', width: 11 },
      ],
      rows: rows.map((r) => [
        r.studentNumber,
        r.fullName,
        r.programme,
        r.level,
        r.studentStatus,
        r.course,
        r.section,
        r.enrolmentStatus,
        date(r.enrolledAt),
        date(r.endedAt),
      ]),
    };
  }
}
