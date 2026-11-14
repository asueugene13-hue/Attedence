import { z } from 'zod';

/**
 * Notifications (Phase 3 step 6). Decided by the product owner 2026-11-09: in-app and email first;
 * push is part of the design but switched off until a university-owned Firebase project exists.
 */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface CategoryRule {
  label: string;
  /** Cannot be turned off: people must hear about cancellations and moves. */
  mandatory: boolean;
  /** Channels used unless the person turned one off. IN_APP is always used. */
  defaultChannels: NotificationChannel[];
}

export const NOTIFICATION_CATEGORIES = {
  CLASS_PROMPT: {
    label: 'Your class needs an update',
    mandatory: false,
    defaultChannels: ['IN_APP', 'PUSH'],
  },
  CLASS_UNCONFIRMED: { label: 'Class not confirmed', mandatory: false, defaultChannels: ['IN_APP', 'PUSH'] },
  CLASS_DELAYED: { label: 'Class delayed', mandatory: false, defaultChannels: ['IN_APP', 'PUSH'] },
  CLASS_UNDER_REVIEW: { label: 'Class under review', mandatory: false, defaultChannels: ['IN_APP', 'PUSH'] },
  CLASS_CANCELLED: {
    label: 'Class cancelled',
    mandatory: true,
    defaultChannels: ['IN_APP', 'EMAIL', 'PUSH'],
  },
  CLASS_RESCHEDULED: {
    label: 'Class rescheduled',
    mandatory: true,
    defaultChannels: ['IN_APP', 'EMAIL', 'PUSH'],
  },
  CLASS_REINSTATED: { label: 'Class back on', mandatory: true, defaultChannels: ['IN_APP', 'EMAIL', 'PUSH'] },
  VENUE_CHANGED: { label: 'Room changed', mandatory: true, defaultChannels: ['IN_APP', 'EMAIL', 'PUSH'] },
  CLASS_AUTO_ENDED: { label: 'Class ended automatically', mandatory: false, defaultChannels: ['IN_APP'] },
  REVIEW_OPENED: { label: 'A class needs review', mandatory: false, defaultChannels: ['IN_APP', 'PUSH'] },
  REVIEW_DECIDED: { label: 'Review decided', mandatory: false, defaultChannels: ['IN_APP'] },
  ATTENDANCE_OPEN: {
    label: 'Attendance is open',
    mandatory: false,
    defaultChannels: ['IN_APP', 'PUSH'],
  },
  ATTENDANCE_DECISIONS_WAITING: {
    label: 'Check-ins waiting for your decision',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  ATTENDANCE_DECISIONS_ESCALATED: {
    label: 'Undecided check-ins passed to administrators',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  CORRECTION_REQUESTED: {
    label: 'Attendance correction to approve',
    mandatory: false,
    defaultChannels: ['IN_APP'],
  },
  CORRECTION_DECIDED: {
    label: 'Attendance correction decided',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  BEACON_FAULT: {
    label: 'Classroom beacon not detected',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL', 'PUSH'],
  },
  DISPUTE_SUBMITTED: { label: 'Attendance dispute to decide', mandatory: false, defaultChannels: ['IN_APP'] },
  DISPUTE_INFO_REQUESTED: {
    label: 'Question about your dispute',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  DISPUTE_REPLIED: {
    label: 'Reply to your question on a dispute',
    mandatory: false,
    defaultChannels: ['IN_APP'],
  },
  DISPUTE_DECIDED: {
    label: 'Your dispute was decided',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  DISPUTE_ESCALATED: {
    label: 'Attendance dispute waiting too long',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  RESCHEDULE_REQUESTED: { label: 'Reschedule request', mandatory: false, defaultChannels: ['IN_APP'] },
  RESCHEDULE_DECIDED: {
    label: 'Reschedule request decided',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
} as const satisfies Record<string, CategoryRule>;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export const NOTIFICATION_CATEGORY_KEYS = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

/** An administrator's "class needs review" alert is also emailed if still unread after this long. */
export const REVIEW_EMAIL_IF_UNREAD_MINUTES = 15;

export const NotificationListQuerySchema = z.strictObject({
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.uuid().optional(),
});

export const UpdatePreferenceSchema = z.strictObject({
  category: z.enum(NOTIFICATION_CATEGORY_KEYS as [NotificationCategory, ...NotificationCategory[]]),
  channel: z.enum(['EMAIL', 'PUSH']),
  enabled: z.boolean(),
});
