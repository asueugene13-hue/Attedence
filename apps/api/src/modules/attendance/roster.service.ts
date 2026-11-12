import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AssistedCheckInSchema,
  type AttendanceStatus,
  type DecideRecordSchema,
  RECORD_RANK,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import type { AttendanceRecord } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { ClassEventService } from '../class-sessions/class-event.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { StudentsService } from '../students/students.service.js';
import { AttendanceEventsService } from './attendance-events.service.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';
import { changeRecordStatus } from './record-changes.js';

const conflict = (code: string, message: string) => new ConflictException({ code, message });

/**
 * The live roster and the lecturer's decisions (ATTENDANCE_FLOW §6–§7, Phase 5 step 3): who is here,
 * approving or rejecting waiting check-ins, approving all of them at once in degraded mode, and
 * checking a student in by hand. Every change is a correction with a reason, a reviewer decision and
 * an audit entry (CLAUDE.md rule 5), version-checked, and announced to the screens watching.
 */
@Injectable()
export class RosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly sessions: AttendanceSessionsService,
    private readonly events: AttendanceEventsService,
    private readonly enrollments: EnrollmentsService,
    private readonly students: StudentsService,
    private readonly classEvents: ClassEventService,
  ) {}

  // ───────── Reading ─────────

  /** Every eligible student (and anyone with a record), with status and latest attempt; plus `seq`. */
  async roster(actor: AccessClaims, attendanceSessionId: string) {
    const { session, cls } = await this.sessions.authorize(
      actor,
      attendanceSessionId,
      'attendance.roster_read',
      'attendance.roster_read',
    );
    const seq = await this.events.currentSeq(session.id); // read first: a later event triggers a reload, never a miss
    const [eligible, records] = await Promise.all([
      this.enrollments.eligibleAt(cls.sectionIds, cls.scheduledStart),
      this.prisma.attendanceRecord.findMany({ where: { attendanceSessionId: session.id } }),
    ]);
    const studentIds = [...new Set([...eligible, ...records.map((r) => r.studentId)])];
    const entries = await this.entries(session.id, studentIds, records);
    const counts: Record<string, number> = { enrolled: eligible.length, notCheckedIn: 0 };
    for (const e of entries) {
      const key = e.status ?? 'notCheckedIn';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      seq,
      session: await this.sessions.get(actor, session.id),
      degraded: await this.classEvents.isBeaconDegraded(cls.id),
      counts,
      students: entries.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  /** One student's roster line, as sent in live events. */
  async entry(attendanceSessionId: string, studentId: string) {
    const records = await this.prisma.attendanceRecord.findMany({
      where: { attendanceSessionId, studentId },
    });
    return (await this.entries(attendanceSessionId, [studentId], records))[0]!;
  }

  private async entries(attendanceSessionId: string, studentIds: string[], records: AttendanceRecord[]) {
    const [people, attempts] = await Promise.all([
      this.students.summaries(studentIds),
      this.prisma.attendanceAttempt.findMany({
        where: { attendanceSessionId, studentId: { in: studentIds } },
        orderBy: { receivedAt: 'desc' },
        select: { id: true, studentId: true, outcome: true, reason: true, receivedAt: true, evidence: true },
      }),
    ]);
    const recordOf = new Map(records.map((r) => [r.studentId, r]));
    return studentIds.map((studentId) => {
      const person = people.get(studentId);
      const record = recordOf.get(studentId);
      const mine = attempts.filter((a) => a.studentId === studentId);
      const last = mine[0];
      const e = (last?.evidence ?? {}) as { ble?: string; gps?: string; device?: string };
      return {
        studentId,
        studentNumber: person?.studentNumber ?? '',
        fullName: person?.fullName ?? '',
        status: (record?.status ?? null) as AttendanceStatus | null,
        source: record?.source ?? null,
        checkedInAt: record?.checkedInAt ?? null,
        recordId: record?.id ?? null,
        version: record?.version ?? null,
        attempts: mine.length,
        lastAttempt: last
          ? {
              id: last.id,
              outcome: last.outcome,
              reason: last.reason,
              receivedAt: last.receivedAt,
              evidence: { ble: e.ble, gps: e.gps, device: e.device },
            }
          : null,
      };
    });
  }

  // ───────── Decisions on waiting check-ins ─────────

  /** Approve (PRESENT, or LATE by the check-in's receipt time) or reject (with a note) one waiting check-in. */
  async decide(
    actor: AccessClaims,
    recordId: string,
    input: z.output<typeof DecideRecordSchema>,
    context: RequestContext,
  ) {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!record) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such attendance record.' });
    const { session, asAdmin } = await this.sessions.authorize(
      actor,
      record.attendanceSessionId,
      'attendance.review_pending',
      'attendance.review_pending',
    );
    if (record.status !== 'PENDING' && record.status !== 'UNDER_REVIEW') {
      throw conflict('NOT_WAITING', 'This check-in is not waiting for a decision.');
    }
    const late = record.checkedInAt !== null && record.checkedInAt > session.lateAfter;
    const to: AttendanceStatus = input.decision === 'APPROVE' ? (late ? 'LATE' : 'PRESENT') : 'REJECTED';
    const reason = input.note ?? (asAdmin ? 'Approved by an administrator.' : 'Approved by the lecturer.');
    await this.prisma.$transaction(async (tx) => {
      await changeRecordStatus(tx, {
        record: record,
        expectedVersion: input.version,
        to: to,
        reason,
        source: asAdmin ? 'ADMINISTRATOR' : 'LECTURER',
        correctedById: actor.userId,
        at: this.clock.now(),
      });
      if (record.attemptId) {
        await tx.verificationDecision.create({
          data: {
            attemptId: record.attemptId,
            outcome: input.decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED',
            decidedBy: asAdmin ? 'ADMINISTRATOR' : 'LECTURER',
            decidedById: actor.userId,
            policyVersion: session.verificationPolicyVersion,
            ruleTrace: [
              `${input.decision === 'APPROVE' ? 'approved' : 'rejected'} by the ${asAdmin ? 'administrator' : 'lecturer'}`,
            ],
            note: input.note ?? null,
            decidedAt: this.clock.now(),
          },
        });
      }
      await this.audit.record(
        auditEntry(
          actor,
          `attendance.check_in_${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`,
          { type: 'attendance_record', id: record.id },
          { before: { status: record.status }, after: { status: to }, reason: input.note },
          context,
        ),
        tx,
      );
    });
    await this.events.publish(session.id, 'record.updated', await this.entry(session.id, record.studentId));
    return this.entry(session.id, record.studentId);
  }

  /**
   * Degraded mode only (§6): approves every check-in that waits only because the beacon was not
   * working. Other waiting check-ins (a new phone, a delayed upload) still need their own decision.
   */
  async approveWaiting(
    actor: AccessClaims,
    attendanceSessionId: string,
    note: string | undefined,
    context: RequestContext,
  ) {
    const { session, cls, asAdmin } = await this.sessions.authorize(
      actor,
      attendanceSessionId,
      'attendance.review_pending',
      'attendance.review_pending',
    );
    if (!(await this.classEvents.isBeaconDegraded(cls.id))) {
      throw conflict(
        'NOT_DEGRADED',
        'Approving all at once is only for a class whose beacon is not working. Decide each check-in.',
      );
    }
    const waiting = await this.prisma.attendanceRecord.findMany({
      where: { attendanceSessionId: session.id, status: 'PENDING', attempt: { reason: 'DEGRADED_MODE' } },
    });
    const reason = note ?? 'Approved together: the classroom beacon was not working.';
    await this.prisma.$transaction(async (tx) => {
      for (const record of waiting) {
        const late = record.checkedInAt !== null && record.checkedInAt > session.lateAfter;
        await changeRecordStatus(tx, {
          record: record,
          expectedVersion: record.version,
          to: late ? 'LATE' : 'PRESENT',
          reason,
          source: asAdmin ? 'ADMINISTRATOR' : 'LECTURER',
          correctedById: actor.userId,
          at: this.clock.now(),
        });
        await tx.verificationDecision.create({
          data: {
            attemptId: record.attemptId!,
            outcome: 'VERIFIED',
            decidedBy: asAdmin ? 'ADMINISTRATOR' : 'LECTURER',
            decidedById: actor.userId,
            policyVersion: session.verificationPolicyVersion,
            ruleTrace: ['approved together in degraded mode'],
            note: note ?? null,
            decidedAt: this.clock.now(),
          },
        });
      }
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.waiting_approved',
          { type: 'attendance_session', id: session.id },
          { after: { approved: waiting.length }, reason },
          context,
        ),
        tx,
      );
    });
    for (const record of waiting) {
      await this.events.publish(session.id, 'record.updated', await this.entry(session.id, record.studentId));
    }
    return { approved: waiting.length };
  }

  // ───────── Assisted check-in ─────────

  /** The lecturer checks a student in by hand while the class runs: how and why are kept. */
  async assist(
    actor: AccessClaims,
    attendanceSessionId: string,
    input: z.output<typeof AssistedCheckInSchema>,
    context: RequestContext,
  ) {
    const { session, cls } = await this.sessions.authorize(
      actor,
      attendanceSessionId,
      'attendance.assisted_checkin',
      'attendance.assisted_checkin',
    );
    if (session.closeReason === 'CLASS_VOIDED') throw conflict('CLASS_VOIDED', 'This class was voided.');
    if (cls.status !== 'ACTIVE' && cls.status !== 'INTERRUPTED') {
      throw conflict(
        'CLASS_NOT_RUNNING',
        'Students can be checked in by hand only while the class is running. Correct the record instead.',
      );
    }
    const eligible = await this.enrollments.isEligible(input.studentId, cls.sectionIds, cls.scheduledStart);
    const enrolledNow = (await this.enrollments.activeSectionIds(input.studentId)).some((id) =>
      cls.sectionIds.includes(id),
    );
    if (!eligible && !enrolledNow)
      throw conflict('NOT_IN_CLASS', 'This student is not enrolled in this class.');
    const now = this.clock.now();
    const to: AttendanceStatus = now > session.lateAfter ? 'LATE' : 'PRESENT';
    await this.prisma.$transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<AttendanceRecord[]>`
        SELECT id, status, version FROM attendance_records
        WHERE class_session_id = ${cls.id}::uuid AND student_id = ${input.studentId}::uuid FOR UPDATE`;
      let recordId: string;
      if (!existing) {
        recordId = (
          await tx.attendanceRecord.create({
            data: {
              classSessionId: cls.id,
              attendanceSessionId: session.id,
              studentId: input.studentId,
              status: to,
              source: 'ASSISTED',
              checkedInAt: now,
            },
          })
        ).id;
      } else {
        if (RECORD_RANK[existing.status] >= RECORD_RANK[to]) {
          throw conflict(
            'ALREADY_RECORDED',
            `This student is already ${existing.status.toLowerCase().replace('_', ' ')} for this class.`,
          );
        }
        const record = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: existing.id } });
        await changeRecordStatus(tx, {
          record: record,
          expectedVersion: record.version,
          to: to,
          reason: input.reason,
          source: 'LECTURER',
          correctedById: actor.userId,
          at: this.clock.now(),
          extra: { source: 'ASSISTED', checkedInAt: now },
        });
        recordId = existing.id;
      }
      await tx.assistedCheckIn.create({
        data: {
          attendanceSessionId: session.id,
          studentId: input.studentId,
          recordId,
          method: input.method,
          reason: input.reason,
          performedById: actor.userId,
          performedAt: now,
        },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'attendance.assisted_check_in',
          { type: 'attendance_record', id: recordId },
          {
            before: existing ? { status: existing.status } : null,
            after: { status: to, method: input.method },
            reason: input.reason,
          },
          context,
        ),
        tx,
      );
    });
    await this.events.publish(session.id, 'record.updated', await this.entry(session.id, input.studentId));
    return this.entry(session.id, input.studentId);
  }
}
