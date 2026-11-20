import { CLASS_ACTIONS } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import type { AuditService } from '../audit-logs/audit.service.js';
import type { RoleKey } from '@attendsure/shared';

/** Statuses from which a class can still be moved (and "rescheduled", which closes its own requests). */
const STILL_MOVABLE: readonly string[] = [...CLASS_ACTIONS.reschedule.adminFrom, 'RESCHEDULED'];

const BECAUSE: Record<string, string> = {
  ACTIVE: 'the class has started',
  INTERRUPTED: 'the class has started',
  COMPLETED: 'the class has ended',
  CANCELLED: 'the class was cancelled',
};

/**
 * Closes a lecturer's waiting reschedule request once its class can no longer be moved: started,
 * ended or cancelled (KNOWN_LIMITATIONS 40). Called in the same transaction as the status change, by
 * every code path that changes a class's status. The request is marked REJECTED with a note saying why,
 * audited (as the person who changed the class, or the system), and the lecturer is told.
 */
export async function closeWaitingReschedules(
  tx: Prisma.TransactionClient,
  services: { outbox: OutboxService; audit: AuditService },
  change: {
    sessionId: string;
    toStatus: string;
    now: Date;
    /** Who changed the class; null for the server's own changes (monitoring). */
    by: { userId: string; role?: RoleKey } | null;
    context?: RequestContext;
  },
): Promise<number> {
  if (STILL_MOVABLE.includes(change.toStatus)) return 0;
  const waiting = await tx.rescheduleRequest.findMany({
    where: { classSessionId: change.sessionId, status: 'PENDING' },
    select: { id: true },
  });
  const note = `Closed automatically: ${BECAUSE[change.toStatus] ?? 'the class can no longer be moved'}.`;
  for (const request of waiting) {
    const closed = await tx.rescheduleRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedById: change.by?.userId ?? null,
        decidedAt: change.now,
        decisionNote: note,
      },
    });
    if (closed.count !== 1) continue;
    await services.outbox.add(tx, 'system', 'reschedule-alert', { requestId: request.id, kind: 'decided' });
    await services.audit.record(
      {
        action: 'reschedule_requests.closed',
        entityType: 'reschedule_request',
        entityId: request.id,
        actorUserId: change.by?.userId ?? null,
        actorRoleKey: change.by?.role ?? null,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', classStatus: change.toStatus },
        reason: note,
        context: change.context,
      },
      tx,
    );
  }
  return waiting.length;
}
