import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { AppConfig } from '../../config/app-config.js';
import { Clock } from '../clock/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobRegistry, QUEUES } from './job-registry.js';
import { bullConnection, JobsService } from './jobs.service.js';
import { SystemEventsService } from './system-events.service.js';

/** Provided by the API (from RUN_JOBS_IN_API) or the worker process (always true). */
export const RUN_JOBS = Symbol('RUN_JOBS');

interface Envelope {
  recordId: string;
  data: unknown;
}

/** How often unpublished outbox rows are looked for. */
const RELAY_INTERVAL_MS = 500;
/** An outbox row that keeps failing to queue is reported once, then left for an operator. */
const MAX_RELAY_ATTEMPTS = 10;

/**
 * Runs queued jobs and relays the outbox. Active in the worker process, and in the API only when
 * RUN_JOBS_IN_API is true. Every run updates its job record; a job that fails its last try is
 * marked DEAD and raises a system event, so no failure is silent.
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobRunner.name);
  private workers: Worker[] = [];
  private relayTimer: NodeJS.Timeout | null = null;
  private relaying: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @Inject(RUN_JOBS) private readonly enabled: boolean,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly jobs: JobsService,
    private readonly events: SystemEventsService,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.workers = QUEUES.map(
      (queue) =>
        new Worker(queue, (job: Job<Envelope>) => this.run(queue, job), {
          connection: bullConnection(this.config),
          concurrency: 5,
        }),
    );
    for (const worker of this.workers) {
      worker.on('failed', (job, error) => {
        if (job)
          void this.recordFailure(job as Job<Envelope>, error).catch((e: unknown) => this.logger.error(e));
      });
      worker.on('error', (error) => this.logger.error(`Queue worker error: ${error.message}`));
    }
    this.relayTimer = setInterval(() => void this.relayOnce(), RELAY_INTERVAL_MS);
    this.logger.log(`Running jobs on queues: ${QUEUES.join(', ')}.`);
  }

  private async run(queue: string, job: Job<Envelope>): Promise<void> {
    const definition = this.registry.get(queue, job.name);
    if (!definition) throw new Error(`No handler for job ${queue}/${job.name}.`);
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    await this.prisma.backgroundJobRecord.update({
      where: { id: job.data.recordId },
      data: { status: 'RUNNING', attempts: attempt, startedAt: this.clock.now() },
    });
    await definition.handle(job.data.data, { attempt, isFinalAttempt: attempt >= maxAttempts });
    await this.prisma.backgroundJobRecord.update({
      where: { id: job.data.recordId },
      data: { status: 'SUCCEEDED', finishedAt: this.clock.now(), lastError: null },
    });
  }

  private async recordFailure(job: Job<Envelope>, error: Error): Promise<void> {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    await this.prisma.backgroundJobRecord.update({
      where: { id: job.data.recordId },
      data: {
        status: final ? 'DEAD' : 'FAILED',
        lastError: error.message.slice(0, 2000),
        finishedAt: final ? this.clock.now() : null,
      },
    });
    if (final) {
      await this.events.raise({
        type: 'job.dead',
        severity: 'HIGH',
        source: `${job.queueName}/${job.name}`,
        message: `A background job failed ${job.attemptsMade} times and was given up: ${error.message}`,
        data: { jobRecordId: job.data.recordId },
      });
    }
  }

  /** Moves committed outbox rows onto their queues. Safe to run from several processes at once. */
  async relayOnce(): Promise<void> {
    if (this.relaying || this.stopping) return this.relaying ?? undefined;
    this.relaying = (async () => {
      const rows = await this.prisma.$queryRaw<
        { id: string; type: string; payload: unknown; attempts: number }[]
      >`
        UPDATE "outbox_events" SET "attempts" = "attempts" + 1
        WHERE "id" IN (
          SELECT "id" FROM "outbox_events"
          WHERE "published_at" IS NULL AND "attempts" < ${MAX_RELAY_ATTEMPTS}
          ORDER BY "created_at" LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "type", "payload", "attempts"`;
      for (const row of rows) {
        const [queue, name] = row.type.split('/') as [(typeof QUEUES)[number], string];
        try {
          await this.jobs.enqueue(queue, name, row.payload as never, { idempotencyKey: `outbox:${row.id}` });
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { publishedAt: this.clock.now(), lastError: null },
          });
        } catch (error) {
          const message = (error as Error).message;
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { lastError: message.slice(0, 2000) },
          });
          if (row.attempts >= MAX_RELAY_ATTEMPTS) {
            await this.events.raise({
              type: 'outbox.stuck',
              severity: 'HIGH',
              source: row.type,
              message: `An outbox event could not be queued after ${row.attempts} tries: ${message}`,
              data: { outboxEventId: row.id },
            });
          }
        }
      }
    })()
      .catch((error: unknown) => this.logger.error(`Outbox relay failed: ${(error as Error).message}`))
      .finally(() => {
        this.relaying = null;
      });
    return this.relaying;
  }

  /** Stops taking new work and lets running jobs finish, before the database connection closes. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.relayTimer) clearInterval(this.relayTimer);
    await this.relaying;
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
