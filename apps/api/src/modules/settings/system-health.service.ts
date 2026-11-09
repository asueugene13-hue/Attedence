import { Injectable, NotFoundException } from '@nestjs/common';
import type { SystemEventQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';

/** Problems the system raised for staff, such as background jobs that failed for good. */
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(q: z.output<typeof SystemEventQuerySchema>) {
    const rows = await this.prisma.systemEvent.findMany({
      where: {
        ...(q.unacknowledged ? { acknowledgedAt: null } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      include: { acknowledgedBy: { select: { id: true, fullName: true } } },
    });
    const page = rows.slice(0, q.limit);
    return { data: page, nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }

  /** Marks an event as seen. Acknowledging twice is harmless and recorded once. */
  async acknowledge(actor: AccessClaims, id: string, context: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.systemEvent.findUnique({ where: { id } });
      if (!event) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such event.' });
      const claimed = await tx.systemEvent.updateMany({
        where: { id, acknowledgedAt: null },
        data: { acknowledgedAt: this.clock.now(), acknowledgedById: actor.userId },
      });
      if (claimed.count === 1) {
        await this.audit.record(
          auditEntry(
            actor,
            'system_events.acknowledged',
            { type: 'system_event', id },
            { after: { type: event.type } },
            context,
          ),
          tx,
        );
      }
      return tx.systemEvent.findUniqueOrThrow({ where: { id } });
    });
  }
}
