import { z } from 'zod';
import type { RoleKey } from './roles.js';

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
  PHONE_APPROVAL_REQUESTED: {
    label: 'A student’s new phone to approve',
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
  EXCUSE_SUBMITTED: { label: 'Excuse request to decide', mandatory: false, defaultChannels: ['IN_APP'] },
  EXCUSE_INFO_REQUESTED: {
    label: 'Question about your excuse request',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  EXCUSE_REPLIED: { label: 'Reply about an excuse request', mandatory: false, defaultChannels: ['IN_APP'] },
  EXCUSE_DECIDED: {
    label: 'Your excuse request was decided',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  ANNOUNCEMENT: { label: 'Announcements', mandatory: false, defaultChannels: ['IN_APP'] },
  ANNOUNCEMENT_EMAILED: {
    label: 'Announcements the sender also emailed',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
  ANNOUNCEMENT_REPORTED: { label: 'Announcement reported', mandatory: false, defaultChannels: ['IN_APP'] },
  REPORT_READY: { label: 'Report file ready', mandatory: false, defaultChannels: ['IN_APP'] },
  REPORT_FAILED: { label: 'Report file could not be made', mandatory: false, defaultChannels: ['IN_APP'] },
  RESCHEDULE_REQUESTED: { label: 'Reschedule request', mandatory: false, defaultChannels: ['IN_APP'] },
  RESCHEDULE_DECIDED: {
    label: 'Reschedule request decided',
    mandatory: false,
    defaultChannels: ['IN_APP', 'EMAIL'],
  },
} as const satisfies Record<string, CategoryRule>;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export const NOTIFICATION_CATEGORY_KEYS = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

const CLASS_CHANGES = ['CLASS_CANCELLED', 'CLASS_RESCHEDULED', 'CLASS_REINSTATED', 'VENUE_CHANGED'] as const;
const REPORT_FILES = ['REPORT_READY', 'REPORT_FAILED'] as const;
const STUDENT_CATEGORIES: readonly NotificationCategory[] = [
  'CLASS_UNCONFIRMED',
  'CLASS_DELAYED',
  'CLASS_UNDER_REVIEW',
  ...CLASS_CHANGES,
  'ATTENDANCE_OPEN',
  'DISPUTE_INFO_REQUESTED',
  'DISPUTE_DECIDED',
  'EXCUSE_INFO_REQUESTED',
  'EXCUSE_DECIDED',
  'ANNOUNCEMENT',
  'ANNOUNCEMENT_EMAILED',
];

/**
 * Which roles can receive each kind of message, taken from the code that sends it. The settings page
 * shows a person only the kinds their roles receive, plus any kind they have actually received or set,
 * so a gap here can never hide a switch someone needs. A test checks every kind has a role.
 */
export const NOTIFICATION_AUDIENCE: Record<RoleKey, readonly NotificationCategory[]> = {
  STUDENT: STUDENT_CATEGORIES,
  COURSE_REP: STUDENT_CATEGORIES,
  LECTURER: [
    'CLASS_PROMPT',
    'CLASS_UNCONFIRMED',
    'CLASS_UNDER_REVIEW',
    'REVIEW_DECIDED',
    ...CLASS_CHANGES,
    'CLASS_AUTO_ENDED',
    'BEACON_FAULT',
    'ATTENDANCE_DECISIONS_WAITING',
    'CORRECTION_DECIDED',
    'DISPUTE_SUBMITTED',
    'DISPUTE_REPLIED',
    'ANNOUNCEMENT_REPORTED',
    'RESCHEDULE_DECIDED',
    ...REPORT_FILES,
  ],
  UNIVERSITY_ADMIN: [
    'REVIEW_OPENED',
    'CLASS_CANCELLED',
    'CLASS_RESCHEDULED',
    'BEACON_FAULT',
    'ATTENDANCE_DECISIONS_ESCALATED',
    'CORRECTION_REQUESTED',
    'DISPUTE_REPLIED',
    'DISPUTE_ESCALATED',
    'EXCUSE_SUBMITTED',
    'EXCUSE_REPLIED',
    'ANNOUNCEMENT_REPORTED',
    'RESCHEDULE_REQUESTED',
    'PHONE_APPROVAL_REQUESTED',
    ...REPORT_FILES,
  ],
  REGISTRAR: ['PHONE_APPROVAL_REQUESTED', ...REPORT_FILES],
  SUPER_ADMIN: ['PHONE_APPROVAL_REQUESTED', ...REPORT_FILES],
};

/** The kinds of message a person holding these roles can receive, in catalogue order. */
export function categoriesForRoles(roles: readonly RoleKey[]): NotificationCategory[] {
  const wanted = new Set<NotificationCategory>(roles.flatMap((r) => NOTIFICATION_AUDIENCE[r]));
  return NOTIFICATION_CATEGORY_KEYS.filter((c) => wanted.has(c));
}

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
