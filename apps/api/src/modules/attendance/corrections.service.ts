import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type CorrectRecordSchema,
  type DecideCorrectionRequestSchema,
  UNDECIDED_ESCALATE_AFTER_HOURS,
  UNDECIDED_MORNING_REMINDER_HOUR,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StudentsService } from '../students/students.service.js';
import { AttendanceEventsService } from './attendance-events.service.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';
import { changeRecordStatus } from './record-changes.js';
import { RosterService } from './roster.service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const conflict = (code: string, message: string) => new ConflictException({ code, message });

/**
 * Correcting attendance (ATTENDANCE_FLOW §5, §7; Phase 5 step 4). A class's lecturer corrects its
 * records directly for a set number of days (default 14); later, the correction waits for an
 * administrator. Administrators in scope correct directly. Every change says from, to, why and who,
 * is version-checked and audited. Check-ins still undecided after attendance closed are reminded to
 * the lecturer and, after 72 hours, passed to administrators; they are never turned into absences.
 */
@Injectable()
export class CorrectionsService implements OnModuleInit {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly sessions: AttendanceSessionsService,
    private readonly events: AttendanceEventsService,
    private readonly roster: RosterService,
    private readonly notifications: NotificationsService,
    private readonly lecturers: LecturersService,
    private readonly courses: CoursesService,
    private readonly scopes: ScopeService,
    private readonly students: StudentsService,
    private readonly classSessions: ClassSessionsService,
  ) {}

  onModuleInit(): void {
    this.jobs.define({
      queue: 'monitoring',
      name: 'attendance-undecided',
      attempts: 3,
      handle: async () => {
        await this.remindUndecided();
      },
    });
    this.jobs.every('monitoring', 'attendance-undecided', 15 * 60_000);
  }

  // ───────── Correcting a record ─────────

  /**
   * Applies a correction, or (for a lecturer after the correction window) records a request for an
   * administrator. Returns `{ applied, record?, request? }`.
   */
  async correct(
    actor: AccessClaims,
    recordId: string,
    input: z.output<typeof CorrectRecordSchema>,
    context: RequestContext,
  ) {
    const record = await this.findRecord(recordId);
    const { session, cls, asAdmin } = await this.sessions.authorize(
      actor,
      record.attendanceSessionId,
      'attendance.correct',
      'attendance.correct',
    );
    if (record.status === 'EXCUSED' || record.status === 'VOIDED') {
      throw conflict(
        'NOT_CORRECTABLE',
        'Excused and voided records are changed only through their own workflows.',
      );
    }
    if (record.status === 'PENDING' || record.status === 'UNDER_REVIEW') {
      throw conflict(
        'DECIDE_INSTEAD',
        'This check-in is waiting for a decision: approve or reject it instead.',
      );
    }
    if (record.status === input.status) throw conflict('NO_CHANGE', 'The record already has this status.');
    if (record.version !== input.version) {
      throw conflict(
        'RECORD_CHANGED',
        'Someone else changed this record a moment ago. Reload and try again.',
      );
    }
    const now = this.clock.now();
    const days = await this.settings.get('attendance.lecturerCorrectionDays');
    if (!asAdmin && now.getTime() > cls.scheduledStart.getTime() + days * DAY) {
      return {
        applied: false,
        request: await this.requestCorrection(actor, record, input, cls.id, days, context),
      };
    }
    await this.prisma.$transaction(async (tx) => {
      await changeRecordStatus(tx, {
        record,
        expectedVersion: input.version,
        to: input.status,
        reason: input.reason,
        source: asAdmin ? 'ADMINISTRATOR' : 'LECTURER',
        correctedById: actor.userId,
        at: now,
      });
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.corrected',
          { type: 'attendance_record', id: record.id },
          { before: { status: record.status }, after: { status: input.status }, reason: input.reason },
          context,
        ),
        tx,
      );
    });
    const entry = await this.roster.entry(session.id, record.studentId);
    await this.events.publish(session.id, 'record.updated', entry);
    return { applied: true, record: entry };
  }

  private async requestCorrection(
    actor: AccessClaims,
    record: { id: string; status: string; version: number; studentId: string },
    input: z.output<typeof CorrectRecordSchema>,
    classId: string,
    days: number,
    context: RequestContext,
  ) {
    let request;
    try {
      request = await this.prisma.$transaction(async (tx) => {
        const created = await tx.attendanceCorrectionRequest.create({
          data: {
            recordId: record.id,
            fromStatus: record.status as never,
            toStatus: input.status,
            reason: input.reason,
            recordVersion: record.version,
            requestedById: actor.userId,
            requestedAt: this.clock.now(),
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'attendance.correction_requested',
            { type: 'attendance_record', id: record.id },
            {
              after: { from: record.status, to: input.status, requestId: created.id, afterDays: days },
              reason: input.reason,
            },
            context,
          ),
          tx,
        );
        return created;
      });
    } catch (error) {
      if (dbErrorInfo(error)?.pgCode === PG.uniqueViolation) {
        throw conflict(
          'REQUEST_PENDING',
          'A correction of this record is already waiting for an administrator.',
        );
      }
      throw error;
    }
    const admins = await this.adminsFor(classId);
    await this.notifications.notify({
      userIds: admins,
      category: 'CORRECTION_REQUESTED',
      title: 'Attendance correction to approve',
      body: `A lecturer asks to change a record from ${record.status.toLowerCase()} to ${input.status.toLowerCase()}, after the ${days}-day window. Reason: ${input.reason}`,
      data: { path: '/attendance-corrections' },
      related: { type: 'attendance_correction_request', id: request.id },
      dedupeKey: `correction-requested:${request.id}`,
    });
    return this.requestView(request);
  }

  // ───────── Administrators decide late corrections ─────────

  async listRequests(actor: AccessClaims, status: 'PENDING' | 'APPROVED' | 'REJECTED') {
    this.assertAdmin(actor);
    const rows = await this.prisma.attendanceCorrectionRequest.findMany({
      where: { status },
      orderBy: { requestedAt: 'asc' },
      take: 500,
      include: { record: true, requestedBy: { select: { fullName: true } } },
    });
    const visible = [];
    for (const r of rows) {
      try {
        await this.sessions.authorize(
          actor,
          r.record.attendanceSessionId,
          'attendance.correct',
          'attendance.correct',
        );
        visible.push(r);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error; // outside this administrator's scope
      }
    }
    const people = await this.students.summaries(visible.map((r) => r.record.studentId));
    return {
      data: visible.map((r) => ({
        ...this.requestView(r),
        classSessionId: r.record.classSessionId,
        student: {
          id: r.record.studentId,
          studentNumber: people.get(r.record.studentId)?.studentNumber ?? '',
          fullName: people.get(r.record.studentId)?.fullName ?? '',
        },
        requestedBy: { fullName: r.requestedBy.fullName },
      })),
    };
  }

  async decideRequest(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof DecideCorrectionRequestSchema>,
    context: RequestContext,
  ) {
    this.assertAdmin(actor);
    const request = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id },
      include: { record: true },
    });
    if (!request) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such correction request.' });
    const { session } = await this.sessions.authorize(
      actor,
      request.record.attendanceSessionId,
      'attendance.correct',
      'attendance.correct',
    );
    if (request.status !== 'PENDING')
      throw conflict('ALREADY_DECIDED', 'This correction has already been decided.');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.attendanceCorrectionRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedById: actor.userId,
          decidedAt: now,
          decisionNote: input.note ?? null,
        },
      });
      if (claimed.count !== 1) throw conflict('ALREADY_DECIDED', 'This correction has already been decided.');
      if (input.decision === 'APPROVE') {
        // Applies only to the record as the lecturer saw it; if it changed since, decide again.
        await changeRecordStatus(tx, {
          record: { id: request.recordId, status: request.fromStatus },
          expectedVersion: request.recordVersion,
          to: request.toStatus,
          reason: request.reason,
          source: 'ADMINISTRATOR',
          sourceId: request.id,
          correctedById: actor.userId,
          at: now,
        });
      }
      await this.audit.record(
        auditEntry(
          actor,
          `attendance.correction_${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`,
          { type: 'attendance_correction_request', id },
          {
            after: { recordId: request.recordId, from: request.fromStatus, to: request.toStatus },
            reason: input.note,
          },
          context,
        ),
        tx,
      );
    });
    await this.notifications.notify({
      userIds: [request.requestedById],
      category: 'CORRECTION_DECIDED',
      title: `Attendance correction ${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`,
      body: `Your correction from ${request.fromStatus.toLowerCase()} to ${request.toStatus.toLowerCase()} was ${input.decision === 'APPROVE' ? 'approved and applied' : 'rejected'}.${input.note ? ` Note: ${input.note}` : ''}`,
      related: { type: 'attendance_correction_request', id },
      dedupeKey: `correction-decided:${id}`,
    });
    if (input.decision === 'APPROVE') {
      await this.events.publish(
        session.id,
        'record.updated',
        await this.roster.entry(session.id, request.record.studentId),
      );
    }
    const decided = await this.prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } });
    return this.requestView(decided);
  }

  // ───────── A record's history ─────────

  /** Every change to a record, the check-in attempts and decisions behind it, and hand check-ins. */
  async history(actor: AccessClaims, recordId: string) {
    const record = await this.findRecord(recordId);
    await this.sessions.authorize(
      actor,
      record.attendanceSessionId,
      'attendance.roster_read',
      'attendance.roster_read',
    );
    const [corrections, attempts, assisted, requests] = await Promise.all([
      this.prisma.attendanceCorrection.findMany({
        where: { recordId },
        orderBy: { correctedAt: 'asc' },
        include: { correctedBy: { select: { fullName: true } } },
      }),
      this.prisma.attendanceAttempt.findMany({
        where: { attendanceSessionId: record.attendanceSessionId, studentId: record.studentId },
        orderBy: { receivedAt: 'asc' },
        include: {
          decisions: {
            orderBy: { decidedAt: 'asc' },
            include: { decidedByUser: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.assistedCheckIn.findMany({
        where: { recordId },
        orderBy: { performedAt: 'asc' },
        include: { performedBy: { select: { fullName: true } } },
      }),
      this.prisma.attendanceCorrectionRequest.findMany({
        where: { recordId },
        orderBy: { requestedAt: 'asc' },
      }),
    ]);
    return {
      record: {
        id: record.id,
        status: record.status,
        source: record.source,
        checkedInAt: record.checkedInAt,
        version: record.version,
        createdAt: record.createdAt,
      },
      corrections: corrections.map((c) => ({
        from: c.fromStatus,
        to: c.toStatus,
        reason: c.reason,
        source: c.source,
        by: c.correctedBy?.fullName ?? null,
        at: c.correctedAt,
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        receivedAt: a.receivedAt,
        outcome: a.outcome,
        reason: a.reason,
        evidence: a.evidence,
        decisions: a.decisions.map((d) => ({
          outcome: d.outcome,
          decidedBy: d.decidedBy,
          by: d.decidedByUser?.fullName ?? null,
          note: d.note,
          trace: d.ruleTrace,
          at: d.decidedAt,
        })),
      })),
      assisted: assisted.map((x) => ({
        method: x.method,
        reason: x.reason,
        by: x.performedBy.fullName,
        at: x.performedAt,
      })),
      requests: requests.map((r) => this.requestView(r)),
    };
  }

  // ───────── Undecided check-ins (server time) ─────────

  /**
   * For closed attendance with check-ins still undecided: remind the lecturer once the class has
   * ended and again the next morning; after 72 hours, tell the administrators responsible (once).
   * Nothing is decided or changed here. Safe to run repeatedly (each message has its own key).
   */
  async remindUndecided(): Promise<{ reminded: number; escalated: number }> {
    const now = this.clock.now();
    const tz = this.config.institutionTimezone;
    let reminded = 0;
    let escalated = 0;
    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        status: 'CLOSED',
        NOT: { closeReason: 'CLASS_VOIDED' },
        records: { some: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } },
      },
    });
    const classes = await this.classSessions.facts(sessions.map((s) => s.classSessionId));
    for (const s of sessions) {
      const cls = classes.get(s.classSessionId);
      if (!cls) continue;
      const waiting = await this.prisma.attendanceRecord.count({
        where: { attendanceSessionId: s.id, status: { in: ['PENDING', 'UNDER_REVIEW'] } },
      });
      const lecturerUserId = (await this.lecturers.facts([cls.lecturerId])).get(cls.lecturerId)?.userId;
      const morning = wallClockToUtc(
        dayIn(new Date(cls.scheduledEnd.getTime() + DAY), tz),
        UNDECIDED_MORNING_REMINDER_HOUR * 60,
        tz,
      );
      for (const [when, kind] of [
        [cls.scheduledEnd, 'end'],
        [morning, 'morning'],
      ] as const) {
        if (now < when || !lecturerUserId) continue;
        const sent = await this.notifications.notify({
          userIds: [lecturerUserId],
          category: 'ATTENDANCE_DECISIONS_WAITING',
          priority: 'HIGH',
          title: `${waiting} check-in${waiting === 1 ? '' : 's'} waiting for your decision`,
          body: 'Some students’ check-ins for your class are waiting for you to approve or reject them. They are not counted until you decide.',
          data: { path: `/classes/${cls.id}` },
          related: { type: 'attendance_session', id: s.id },
          dedupeKey: `undecided:${kind}:${s.id}`,
        });
        if (sent) reminded++;
      }
      if (
        !s.undecidedEscalatedAt &&
        s.closedAt &&
        now.getTime() >= s.closedAt.getTime() + UNDECIDED_ESCALATE_AFTER_HOURS * HOUR
      ) {
        const claimed = await this.prisma.attendanceSession.updateMany({
          where: { id: s.id, undecidedEscalatedAt: null },
          data: { undecidedEscalatedAt: now },
        });
        if (claimed.count !== 1) continue;
        await this.audit.record({
          action: 'attendance.undecided_escalated',
          entityType: 'attendance_session',
          entityId: s.id,
          after: { waiting },
        });
        await this.notifications.notify({
          userIds: await this.adminsFor(cls.id),
          category: 'ATTENDANCE_DECISIONS_ESCALATED',
          priority: 'HIGH',
          title: `${waiting} check-in${waiting === 1 ? '' : 's'} still undecided after ${UNDECIDED_ESCALATE_AFTER_HOURS} hours`,
          body: 'The lecturer has not decided some check-ins for a class. Please approve or reject them; they are not counted until someone does.',
          data: { path: `/classes/${cls.id}` },
          related: { type: 'attendance_session', id: s.id },
          dedupeKey: `undecided:escalated:${s.id}`,
        });
        escalated++;
      }
    }
    return { reminded, escalated };
  }

  // ───────── Helpers ─────────

  private async findRecord(id: string) {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such attendance record.' });
    return record;
  }

  private assertAdmin(actor: AccessClaims) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Only administrators decide late corrections.',
      });
    }
  }

  /** The University Administrators responsible for a class's departments. */
  private async adminsFor(classSessionId: string): Promise<string[]> {
    const cls = (await this.classSessions.facts([classSessionId])).get(classSessionId);
    const sections = await this.courses.sectionSummaries(cls?.sectionIds ?? []);
    const admins = new Set<string>();
    for (const s of sections.values()) {
      for (const id of await this.scopes.holdersCovering('UNIVERSITY_ADMIN', s.department)) admins.add(id);
    }
    if (admins.size === 0) this.logger.warn(`No administrator found for class ${classSessionId}`);
    return [...admins];
  }

  private requestView(r: {
    id: string;
    recordId: string;
    fromStatus: string;
    toStatus: string;
    reason: string;
    status: string;
    requestedAt: Date;
    decidedAt: Date | null;
    decisionNote: string | null;
  }) {
    return {
      id: r.id,
      recordId: r.recordId,
      from: r.fromStatus,
      to: r.toStatus,
      reason: r.reason,
      status: r.status,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
    };
  }
}
