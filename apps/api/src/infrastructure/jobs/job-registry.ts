import { Injectable } from '@nestjs/common';

/** The queues jobs run on. Separate queues keep slow email from delaying class monitoring. */
export const QUEUES = ['email', 'monitoring', 'system'] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobContext {
  attempt: number;
  /** True on the last try: a handler can record a final failure (for example "email FAILED"). */
  isFinalAttempt: boolean;
}

export interface JobDefinition<T = unknown> {
  queue: QueueName;
  name: string;
  /** Tries before the job is given up (default 5), with growing waits between them. */
  attempts?: number;
  handle(data: T, context: JobContext): Promise<void>;
}

/**
 * Feature modules declare their jobs here (usually in onModuleInit). The runner looks a job up by
 * queue and name when it runs, so the API and the worker share one list of what each job does.
 */
@Injectable()
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();
  private readonly schedules: { queue: QueueName; name: string; everyMs: number }[] = [];

  define<T>(definition: JobDefinition<T>): void {
    const key = `${definition.queue}/${definition.name}`;
    if (this.definitions.has(key)) throw new Error(`Job ${key} is defined twice.`);
    this.definitions.set(key, definition as JobDefinition);
  }

  /**
   * Runs an already defined job (with no data) every `everyMs`. Each period is queued once, even with
   * several processes running jobs, and is recorded like any other job.
   */
  every(queue: QueueName, name: string, everyMs: number): void {
    if (!this.get(queue, name)) throw new Error(`Define job ${queue}/${name} before scheduling it.`);
    this.schedules.push({ queue, name, everyMs });
  }

  scheduled(): readonly { queue: QueueName; name: string; everyMs: number }[] {
    return this.schedules;
  }

  get(queue: string, name: string): JobDefinition | undefined {
    return this.definitions.get(`${queue}/${name}`);
  }

  attemptsFor(queue: QueueName, name: string): number {
    return this.get(queue, name)?.attempts ?? 5;
  }
}
