import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { QueueName } from './job-registry.js';

/**
 * Records "run this job" in the same database transaction as the change that needs it. If the
 * transaction rolls back, the job never happens; if it commits, the relay is certain to queue it,
 * even if Redis or the process was down at that moment.
 */
@Injectable()
export class OutboxService {
  async add(tx: Prisma.TransactionClient, queue: QueueName, name: string, payload: Prisma.InputJsonValue) {
    await tx.outboxEvent.create({ data: { type: `${queue}/${name}`, payload } });
  }
}
