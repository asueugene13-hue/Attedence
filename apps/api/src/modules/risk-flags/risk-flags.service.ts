import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { auditEntry } from '../../common/audit-entry.js';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { FlagStatus, Prisma, RiskType, Severity } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { StudentsService } from '../students/students.service.js';

export interface RaiseFlag {
  type: RiskType;
  severity: Severity;
  studentId?: string | null;
  deviceId?: string | null;
  evidence: Prisma.InputJsonValue;
  /** The same situation is flagged once while its flag is open. */
  dedupeKey?: string;
}

/**
 * Risk flags (PRESENCE_VERIFICATION.md §5, §8). Other modules raise them; a person reviews each one.
 * A flag never changes attendance or access by itself.
 */
@Injectable()
export class RiskFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly students: StudentsService,
    private readonly clock: Clock,
  ) {}

  /** Raises a flag, or does nothing if the same situation already has an open flag. */
  async raise(flag: RaiseFlag, tx?: Prisma.TransactionClient): Promise<void> {
    // The savepoint below needs a transaction: use the caller's, or start one.
    if (!tx) return this.prisma.$transaction((own) => this.raise(flag, own));
    try {
      // A savepoint keeps a duplicate from aborting the caller's transaction.
      await tx.$executeRaw`SAVEPOINT raise_flag`;
      await tx.riskFlag.create({
        data: {
          type: flag.type,
          severity: flag.severity,
          studentId: flag.studentId ?? null,
          deviceId: flag.deviceId ?? null,
          evidence: flag.evidence,
          dedupeKey: flag.dedupeKey ?? null,
          createdAt: this.clock.now(),
        },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT raise_flag`;
    } catch (error) {
      if (dbErrorInfo(error)?.pgCode !== PG.uniqueViolation) throw error;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT raise_flag`;
    }
  }

  async list(filter: { status: FlagStatus; type?: RiskType }) {
    const rows = await this.prisma.riskFlag.findMany({
      where: { status: filter.status, ...(filter.type ? { type: filter.type } : {}) },
      orderBy: { createdAt: filter.status === 'OPEN' ? 'asc' : 'desc' },
      take: 500,
      include: { reviewedBy: { select: { id: true, fullName: true } } },
    });
    const students = await this.students.summaries(rows.flatMap((r) => (r.studentId ? [r.studentId] : [])));
    return {
      data: rows.map((r) => {
        const student = r.studentId ? students.get(r.studentId) : undefined;
        return {
          id: r.id,
          type: r.type,
          severity: r.severity,
          status: r.status,
          student: student
            ? { id: student.id, studentNumber: student.studentNumber, fullName: student.fullName }
            : null,
          deviceId: r.deviceId,
          evidence: r.evidence,
          reviewedBy: r.reviewedBy,
          reviewedAt: r.reviewedAt,
          reviewNote: r.reviewNote,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  async review(
    actor: AccessClaims,
    id: string,
    decision: 'CONFIRMED' | 'DISMISSED',
    note: string,
    context: RequestContext,
  ) {
    const flag = await this.prisma.riskFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such risk flag.' });
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.riskFlag.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: decision, reviewedById: actor.userId, reviewedAt: now, reviewNote: note },
      });
      if (done.count !== 1) {
        throw new ConflictException({
          code: 'ALREADY_REVIEWED',
          message: 'This flag has already been reviewed.',
        });
      }
      await this.audit.record(
        auditEntry(
          actor,
          'risk_flags.reviewed',
          { type: 'risk_flag', id },
          { before: { status: 'OPEN' }, after: { status: decision, type: flag.type }, reason: note },
          context,
        ),
        tx,
      );
    });
    return (await this.list({ status: decision })).data.find((f) => f.id === id)!;
  }
}
