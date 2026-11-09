import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfig } from '../../config/app-config.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobRegistry, type QueueName } from './job-registry.js';

export interface EnqueueOptions {
  /** Waits this long before the job may run (checkpoints use this from step 5). */
  delayMs?: number;
  /** A job with the same key is never queued twice (for example "outbox:<id>"). */
  idempotencyKey?: string;
}

/** BullMQ needs this for its blocking connections. */
export const bullConnection = (config: AppConfig) => ({ url: config.redisUrl, maxRetriesPerRequest: null });

/**
 * Puts jobs on a queue and records each one in background_job_records, so every background task is
 * visible and traceable. Prefer OutboxService when the job follows a database change: it guarantees
 * the job exists if, and only if, the change was saved.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly registry: JobRegistry,
  ) {}

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: bullConnection(this.config) });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue(queue: QueueName, name: string, data: Prisma.InputJsonValue, options: EnqueueOptions = {}) {
    if (options.idempotencyKey) {
      const existing = await this.prisma.backgroundJobRecord.findUnique({
        where: { idempotencyKey: options.idempotencyKey },
      });
      if (existing) return existing;
    }
    const scheduledFor = options.delayMs ? new Date(Date.now() + options.delayMs) : null;
    const record = await this.prisma.backgroundJobRecord.create({
      data: { queue, name, jobId: 'pending', idempotencyKey: options.idempotencyKey, scheduledFor },
    });
    // The record id doubles as the job id, so a job and its record always match.
    await this.prisma.backgroundJobRecord.update({ where: { id: record.id }, data: { jobId: record.id } });
    await this.queue(queue).add(
      name,
      { recordId: record.id, data },
      {
        jobId: record.id,
        delay: options.delayMs,
        attempts: this.registry.attemptsFor(queue, name),
        backoff: { type: 'exponential', delay: this.config.jobRetryDelayMs },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return record;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
