import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { JobMonitorService } from '../../infrastructure/jobs/job-monitor.service.js';
import { SystemHealthService } from '../settings/system-health.service.js';

type Snapshot = Awaited<ReturnType<JobMonitorService['overview']>> & { unacknowledged: number };

/**
 * The metrics this process exposes: Node.js process figures (memory, event-loop delay, …) plus counts
 * read at each scrape: background jobs in the last day by status, jobs per queue, overdue schedules,
 * outbox rows not yet published and unacknowledged system events. No personal data.
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  /** Read once per scrape, before the gauges report (prom-client asks them all at once). */
  private snapshot: Snapshot | null = null;

  constructor(
    private readonly jobs: JobMonitorService,
    private readonly health: SystemHealthService,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'attendsure_' });
    const current = (): Snapshot | null => this.snapshot;
    new Gauge({
      name: 'attendsure_job_runs_last_day',
      help: 'Background job runs created in the last 24 hours, by status.',
      labelNames: ['status'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [status, n] of Object.entries(current()?.lastDay ?? {})) this.set({ status }, n);
      },
    });
    new Gauge({
      name: 'attendsure_queue_jobs',
      help: 'Jobs in each queue, by state.',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [queue, counts] of Object.entries(current()?.queues ?? {})) {
          for (const [state, n] of Object.entries(counts ?? {})) this.set({ queue, state }, n);
        }
      },
    });
    new Gauge({
      name: 'attendsure_schedules_overdue',
      help: 'Scheduled jobs that have not succeeded for three of their periods (jobs may not be running).',
      registers: [this.registry],
      collect() {
        this.set(current()?.schedules.filter((s) => s.overdue).length ?? 0);
      },
    });
    new Gauge({
      name: 'attendsure_outbox_waiting',
      help: 'Outbox rows not yet handed to a queue.',
      registers: [this.registry],
      collect() {
        this.set(current()?.outboxWaiting ?? 0);
      },
    });
    new Gauge({
      name: 'attendsure_system_events_unacknowledged',
      help: 'System events nobody has acknowledged yet.',
      registers: [this.registry],
      collect() {
        this.set(current()?.unacknowledged ?? 0);
      },
    });
  }

  async text(): Promise<string> {
    const [overview, unacknowledged] = await Promise.all([
      this.jobs.overview(),
      this.health.unacknowledgedCount(),
    ]);
    this.snapshot = { ...overview, unacknowledged };
    return this.registry.metrics();
  }
}
