import { ConflictException } from '@nestjs/common';
import type { AttendanceStatus } from '@attendsure/shared';
import type { AttendanceRecord, CorrectionSource, Prisma } from '../../generated/prisma/client.js';

/**
 * The one way an existing record's status changes after it was created (CLAUDE.md rule 5): only if
 * nobody changed it first (same version), and always with a correction row saying from, to, why,
 * who and through what. Used by decisions, hand check-ins, corrections and approved requests.
 */
export async function changeRecordStatus(
  tx: Prisma.TransactionClient,
  args: {
    record: Pick<AttendanceRecord, 'id' | 'status'>;
    expectedVersion: number;
    to: AttendanceStatus;
    reason: string;
    source: CorrectionSource;
    sourceId?: string | null;
    correctedById: string;
    at: Date;
    extra?: Prisma.AttendanceRecordUncheckedUpdateManyInput;
  },
): Promise<void> {
  const claimed = await tx.attendanceRecord.updateMany({
    where: { id: args.record.id, version: args.expectedVersion },
    data: { ...args.extra, status: args.to, version: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    throw new ConflictException({
      code: 'RECORD_CHANGED',
      message: 'Someone else changed this record a moment ago. Reload and try again.',
    });
  }
  await tx.attendanceCorrection.create({
    data: {
      recordId: args.record.id,
      fromStatus: args.record.status,
      toStatus: args.to,
      reason: args.reason,
      source: args.source,
      sourceId: args.sourceId ?? null,
      correctedById: args.correctedById,
      correctedAt: args.at,
    },
  });
}
