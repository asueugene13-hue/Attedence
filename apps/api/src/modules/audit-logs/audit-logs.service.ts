import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuditLogQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ScopeService } from '../authorization/scope.service.js';

export type AuditFilters = Omit<z.output<typeof AuditLogQuerySchema>, 'limit' | 'cursor'>;

/** At most this many entries go into one exported file (narrow the dates for more). */
export const AUDIT_EXPORT_MAX_ROWS = 20_000;

/**
 * Reading the audit log (search on screen, and the exported file). Only the Super Admin and
 * university-wide administrators may: filtering every kind of entry by faculty is not built, and showing
 * everything would exceed a limited administrator's scope (KNOWN_LIMITATIONS). Reading is itself
 * audited by the callers.
 */
@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: ScopeService,
  ) {}

  async assertCanRead(actor: AccessClaims): Promise<void> {
    if (actor.role === 'SUPER_ADMIN') return;
    if (!(await this.scopes.scopeFor(actor.userId, actor.role)).institutionWide) {
      throw new ForbiddenException({
        code: 'SCOPE_REQUIRED',
        message: 'Audit search for a faculty or department scope is not available yet.',
      });
    }
  }

  where(filters: AuditFilters): Prisma.AuditLogWhereInput {
    return {
      ...(filters.action ? { action: { startsWith: filters.action } } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };
  }

  /** Entries for an exported file, newest first, with the actor's name; `truncated` when capped. */
  async forExport(actor: AccessClaims, filters: AuditFilters) {
    await this.assertCanRead(actor);
    const rows = await this.prisma.auditLog.findMany({
      where: this.where(filters),
      orderBy: { id: 'desc' },
      take: AUDIT_EXPORT_MAX_ROWS + 1,
      include: { actor: { select: { fullName: true, email: true } } },
    });
    return { rows: rows.slice(0, AUDIT_EXPORT_MAX_ROWS), truncated: rows.length > AUDIT_EXPORT_MAX_ROWS };
  }
}
