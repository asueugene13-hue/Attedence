import type { ClassEventType, Prisma } from '../../generated/prisma/client.js';
import type { OutboxService } from '../../infrastructure/jobs/outbox.service.js';

/** Class events people are told about (CLASS_MONITORING.md §4). */
export const ALERTED_EVENTS: readonly ClassEventType[] = [
  'LECTURER_PROMPTED',
  'MARKED_UNCONFIRMED',
  'DELAY_REPORTED',
  'ESCALATED',
  'REVIEW_DECIDED',
  'CANCELLED',
  'RESCHEDULED',
  'REINSTATED',
  'VENUE_CHANGED',
  'AUTO_ENDED',
  'BEACON_DEGRADED',
  'ATTENDANCE_OPENED',
];

/**
 * The one way class events are written. An event people must hear about also queues its alert job
 * in the same transaction, so an alert exists if, and only if, the event was saved.
 */
export async function writeClassEvent(
  tx: Prisma.TransactionClient,
  outbox: OutboxService,
  args: { data: Prisma.ClassEventUncheckedCreateInput },
) {
  const event = await tx.classEvent.create(args);
  if (ALERTED_EVENTS.includes(event.type)) {
    await outbox.add(tx, 'system', 'class-alert', { eventId: event.id });
  }
  return event;
}
