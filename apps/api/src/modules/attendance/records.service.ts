import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AttendanceStatus } from '@attendsure/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { AttendanceEventsService } from './attendance-events.service.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';
import { changeRecordStatus } from './record-changes.js';
import { RosterService } from './roster.service.js';

export interface RecordFacts {
  id: string;
  status: AttendanceStatus;
  version: number;
  studentId: string;
  classSessionId: string;
  attendanceSessionId: string;
  /** Attendance for the class has closed (and the class was not voided). */
  attendanceClosed: boolean;
}

/**
 * What other modules (disputes, excuse requests) may know about and do to attendance records
 * (CLAUDE.md rule 8). They never read or write the attendance tables themselves: they ask here, and a
 * change goes through the same versioned, corrected and announced path as every other change.
 */
@Injectable()
export class AttendanceRecordsService {
  private readonly logger = new Logger(AttendanceRecordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AttendanceSessionsService,
    private readonly roster: RosterService,
    private readonly events: AttendanceEventsService,
    private readonly classSessions: ClassSessionsService,
    private readonly courses: CoursesService,
    private readonly scopes: ScopeService,
  ) {}

  /** The student's record for a class, or null if there is none (attendance never taken, not enrolled). */
  async forStudentClass(studentId: string, classSessionId: string): Promise<RecordFacts | null> {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { classSessionId_studentId: { classSessionId, studentId } },
      include: { attendanceSession: { select: { status: true, closeReason: true } } },
    });
    return record ? toFacts(record) : null;
  }

  async facts(ids: string[]): Promise<Map<string, RecordFacts>> {
    const rows = await this.prisma.attendanceRecord.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: { attendanceSession: { select: { status: true, closeReason: true } } },
    });
    return new Map(rows.map((r) => [r.id, toFacts(r)]));
  }

  /**
   * Checks that the actor may review requests about this record: the class's own lecturer, or an
   * administrator whose scope covers the class (both holding `permission`). Throws 403 otherwise.
   */
  async authorizeReview(actor: AccessClaims, recordId: string, permission: string) {
    const record = (await this.facts([recordId])).get(recordId);
    if (!record) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such attendance record.' });
    const { cls, asAdmin } = await this.sessions.authorize(
      actor,
      record.attendanceSessionId,
      permission,
      permission,
    );
    return { record, cls, asAdmin };
  }

  /** The check-in attempts behind a record, as the student may see them (no evidence details). */
  async attemptsFor(recordId: string) {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!record) return [];
    const attempts = await this.prisma.attendanceAttempt.findMany({
      where: { attendanceSessionId: record.attendanceSessionId, studentId: record.studentId },
      orderBy: { receivedAt: 'asc' },
      select: { receivedAt: true, outcome: true, reason: true },
    });
    return attempts;
  }

  /**
   * Changes a record because a request (dispute, excuse) was approved, inside the caller's transaction:
   * only if its status is still one of `allowedFrom`, version-checked, with a correction row naming the
   * request. Throws 409 RECORD_CHANGED if the record moved on since. Call `announce` after commit.
   */
  async changeForRequest(
    tx: Prisma.TransactionClient,
    args: {
      recordId: string;
      allowedFrom: readonly AttendanceStatus[];
      to: AttendanceStatus;
      reason: string;
      source: 'DISPUTE' | 'EXCUSE';
      sourceId: string;
      actorId: string;
      at: Date;
    },
  ): Promise<{ from: AttendanceStatus }> {
    const record = await tx.attendanceRecord.findUnique({ where: { id: args.recordId } });
    if (!record) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such attendance record.' });
    if (!args.allowedFrom.includes(record.status as AttendanceStatus)) {
      throw new ConflictException({
        code: 'RECORD_CHANGED',
        message: `The record is now ${record.status.toLowerCase()}, so this request no longer applies. Reject it with a note instead.`,
      });
    }
    await changeRecordStatus(tx, {
      record,
      expectedVersion: record.version,
      to: args.to,
      reason: args.reason,
      source: args.source,
      sourceId: args.sourceId,
      correctedById: args.actorId,
      at: args.at,
    });
    return { from: record.status as AttendanceStatus };
  }

  /** Tells live rosters that a record changed (after the change was committed). */
  async announce(recordId: string): Promise<void> {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!record) return;
    await this.events.publish(
      record.attendanceSessionId,
      'record.updated',
      await this.roster.entry(record.attendanceSessionId, record.studentId),
    );
  }

  /**
   * What waits for a lecturer about attendance: check-ins not yet decided in their classes, their own
   * late corrections (waiting, and answered since `since`), and records excused in their classes since
   * `since` (counts only; never why).
   */
  async lecturerCounts(lecturerId: string, userId: string, since: Date) {
    const [checkInsWaiting, excused, correctionsWaiting, correctionsAnswered] = await Promise.all([
      this.prisma.attendanceRecord.count({
        where: { status: { in: ['PENDING', 'UNDER_REVIEW'] }, classSession: { lecturerId } },
      }),
      this.prisma.attendanceCorrection.count({
        where: { toStatus: 'EXCUSED', correctedAt: { gte: since }, record: { classSession: { lecturerId } } },
      }),
      this.prisma.attendanceCorrectionRequest.count({ where: { requestedById: userId, status: 'PENDING' } }),
      this.prisma.attendanceCorrectionRequest.count({
        where: { requestedById: userId, status: { not: 'PENDING' }, decidedAt: { gte: since } },
      }),
    ]);
    return { checkInsWaiting, excused, correctionsWaiting, correctionsAnswered };
  }

  /** The University Administrators responsible for a class's departments. */
  async adminsFor(classSessionId: string): Promise<string[]> {
    const cls = (await this.classSessions.facts([classSessionId])).get(classSessionId);
    const sections = await this.courses.sectionSummaries(cls?.sectionIds ?? []);
    const admins = new Set<string>();
    for (const s of sections.values()) {
      for (const id of await this.scopes.holdersCovering('UNIVERSITY_ADMIN', s.department)) admins.add(id);
    }
    if (admins.size === 0) this.logger.warn(`No administrator found for class ${classSessionId}`);
    return [...admins];
  }
}

function toFacts(r: {
  id: string;
  status: string;
  version: number;
  studentId: string;
  classSessionId: string;
  attendanceSessionId: string;
  attendanceSession: { status: string; closeReason: string | null };
}): RecordFacts {
  return {
    id: r.id,
    status: r.status as AttendanceStatus,
    version: r.version,
    studentId: r.studentId,
    classSessionId: r.classSessionId,
    attendanceSessionId: r.attendanceSessionId,
    attendanceClosed:
      r.attendanceSession.status === 'CLOSED' && r.attendanceSession.closeReason !== 'CLASS_VOIDED',
  };
}
