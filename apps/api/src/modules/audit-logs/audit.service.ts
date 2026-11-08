import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma, RoleKey } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorRoleKey?: RoleKey | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
  context?: RequestContext;
}

type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Writes to the append-only audit log. Pass the transaction client when the audited change happens in a
 * transaction, so the change and its audit entry are saved together or not at all.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: AuditWriter = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorType: entry.actorUserId ? 'USER' : 'SYSTEM',
        actorUserId: entry.actorUserId ?? null,
        actorRoleKey: entry.actorRoleKey ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before,
        after: entry.after,
        reason: entry.reason,
        requestId: entry.context?.requestId,
        ip: entry.context?.ip,
        userAgent: entry.context?.userAgent,
      },
    });
  }
}
