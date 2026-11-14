import { Injectable } from '@nestjs/common';
import { Clock } from '../clock/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobRegistry, QUEUES } from './job-registry.js';
import { JobsService } from './jobs.service.js';

const DAY = 24 * 3_600_000;
/** A scheduled job that has not succeeded for this many of its periods is shown as overdue. */
const OVERDUE_AFTER_PERIODS = 3;

/**
 * What the background jobs are doing (Phase 7 step 4), for the System health page and the metrics:
 * the last day's runs by status, recent failures, each schedule's last success (and whether it is
 * overdue, which means jobs are not running), the queues and the outbox. Read only.
 */
@Injectable()
export class JobMonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly registry: JobRegistry,
    private readonly jobs: JobsService,
  ) {}

  async overview() {
    const now = this.clock.now();
    const since = new Date(now.getTime() - DAY);
    const [byStatus, failures, outboxWaiting, queues, schedules] = await Promise.all([
      this.prisma.backgroundJobRecord.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.backgroundJobRecord.findMany({
        where: { status: { in: ['FAILED', 'DEAD'] }, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          queue: true,
          name: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.queueCounts(),
      this.schedules(now),
    ]);
    return {
      checkedAt: now,
      lastDay: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      recentFailures: failures,
      schedules,
      queues,
      outboxWaiting,
    };
  }

  /** Jobs waiting, running, delayed and failed in each queue (from Redis). Null if Redis cannot be read. */
  private async queueCounts() {
    const out: Record<string, Record<string, number> | null> = {};
    for (const q of QUEUES) {
      try {
        out[q] = await this.jobs.queue(q).getJobCounts('waiting', 'active', 'delayed', 'failed');
      } catch {
        out[q] = null;
      }
    }
    return out;
  }

  private async schedules(now: Date) {
    return Promise.all(
      this.registry.scheduled().map(async (s) => {
        const last = await this.prisma.backgroundJobRecord.findFirst({
          where: { queue: s.queue, name: s.name, status: 'SUCCEEDED' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true },
        });
        const lastSucceededAt = last?.finishedAt ?? null;
        return {
          job: `${s.queue}/${s.name}`,
          everyMinutes: Math.round((s.everyMs / 60_000) * 10) / 10,
          lastSucceededAt,
          overdue:
            !lastSucceededAt || now.getTime() - lastSucceededAt.getTime() > OVERDUE_AFTER_PERIODS * s.everyMs,
        };
      }),
    );
  }
}
