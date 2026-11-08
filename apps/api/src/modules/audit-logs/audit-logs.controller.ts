import { Controller, ForbiddenException, Get, Query, Req } from '@nestjs/common';
import { AuditLogQuerySchema } from '@attendsure/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { ScopeService } from '../authorization/scope.service.js';
import { AuditService } from './audit.service.js';

type AuditQuery = z.output<typeof AuditLogQuerySchema>;

@Controller('audit-logs')
export class AuditLogsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
  ) {}

  /**
   * Searches the audit log, newest first. Looking at the audit log is itself audited.
   * Administrators with a faculty or department scope cannot search yet: filtering entries by faculty
   * needs the academic structure (Phase 2), and showing everything would exceed their scope.
   */
  @Get()
  @RequirePermissions('audit_logs.read')
  async search(@CurrentAuth() auth: AccessClaims, @Query() rawQuery: unknown, @Req() req: Request) {
    const query = parseInput(AuditLogQuerySchema, rawQuery);
    if (
      auth.role !== 'SUPER_ADMIN' &&
      !(await this.scopes.scopeFor(auth.userId, auth.role)).institutionWide
    ) {
      throw new ForbiddenException({
        code: 'SCOPE_REQUIRED',
        message: 'Audit search for a faculty or department scope is not available yet.',
      });
    }

    const rows = await this.prisma.auditLog.findMany({
      where: this.whereFor(query),
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { actor: { select: { id: true, email: true, fullName: true } } },
    });
    const page = rows.slice(0, query.limit);

    const { limit: _limit, cursor: _cursor, ...filters } = query;
    await this.audit.record({
      action: 'audit_logs.searched',
      entityType: 'audit_log',
      actorUserId: auth.userId,
      actorRoleKey: auth.role,
      after: { filters, results: page.length },
      context: requestContextOf(req),
    });

    return {
      data: page.map(({ actorUserId: _actorId, ...entry }) => entry),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private whereFor(query: AuditQuery): Prisma.AuditLogWhereInput {
    return {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };
  }
}
