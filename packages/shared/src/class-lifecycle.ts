import { z } from 'zod';
import { ReasonSchema } from './admin.js';
import type { PermissionKey } from './permissions.js';
import type { CLASS_STATUSES } from './timetables.js';

/**
 * The allowed class-status changes (CLASS_LIFECYCLE.md §4), as one table shared by the API and the
 * apps. The API is the only place a status changes; the apps use this table only to decide which
 * buttons to show. Automatic changes (UNCONFIRMED, UNDER_REVIEW, auto-end) come with monitoring.
 */
type Status = (typeof CLASS_STATUSES)[number];

const NOT_STARTED: Status[] = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED', 'UNDER_REVIEW'];

export interface ClassAction {
  to: Status;
  /** Statuses from which the class's own lecturer may do this (empty: lecturers may not). */
  lecturerFrom: Status[];
  /** Statuses from which an administrator (within scope) may do this. */
  adminFrom: Status[];
  lecturerPermission?: PermissionKey;
  adminPermission?: PermissionKey;
  /** A reason is required and recorded. */
  needsReason: boolean;
  label: string;
}

export const CLASS_ACTIONS = {
  confirm: {
    to: 'CONFIRMED',
    lecturerFrom: ['SCHEDULED'],
    adminFrom: [],
    lecturerPermission: 'class_sessions.start',
    needsReason: false,
    label: 'Confirm class',
  },
  delay: {
    to: 'POSTPONED',
    lecturerFrom: ['SCHEDULED', 'CONFIRMED', 'UNCONFIRMED'],
    adminFrom: ['SCHEDULED', 'CONFIRMED', 'UNCONFIRMED'],
    lecturerPermission: 'class_sessions.delay',
    adminPermission: 'class_sessions.delay',
    needsReason: true,
    label: 'Report a delay',
  },
  start: {
    to: 'ACTIVE',
    lecturerFrom: NOT_STARTED,
    adminFrom: [],
    lecturerPermission: 'class_sessions.start',
    needsReason: false,
    label: 'Start class',
  },
  end: {
    to: 'COMPLETED',
    lecturerFrom: ['ACTIVE', 'INTERRUPTED'],
    adminFrom: ['INTERRUPTED'],
    lecturerPermission: 'class_sessions.start',
    adminPermission: 'class_sessions.suspend',
    needsReason: false,
    label: 'End class',
  },
  interrupt: {
    to: 'INTERRUPTED',
    lecturerFrom: ['ACTIVE'],
    adminFrom: ['ACTIVE'],
    lecturerPermission: 'class_sessions.start',
    adminPermission: 'class_sessions.suspend',
    needsReason: true,
    label: 'Report an interruption',
  },
  resume: {
    to: 'ACTIVE',
    lecturerFrom: ['INTERRUPTED'],
    adminFrom: [],
    lecturerPermission: 'class_sessions.start',
    needsReason: false,
    label: 'Resume class',
  },
  cancel: {
    to: 'CANCELLED',
    lecturerFrom: NOT_STARTED,
    adminFrom: [...NOT_STARTED, 'SUSPENDED'],
    lecturerPermission: 'class_sessions.cancel',
    adminPermission: 'class_sessions.cancel',
    needsReason: false,
    label: 'Cancel class',
  },
  suspend: {
    to: 'SUSPENDED',
    lecturerFrom: [],
    adminFrom: NOT_STARTED,
    adminPermission: 'class_sessions.suspend',
    needsReason: true,
    label: 'Put on hold',
  },
  liftHold: {
    to: 'SCHEDULED',
    lecturerFrom: [],
    adminFrom: ['SUSPENDED'],
    adminPermission: 'class_sessions.suspend',
    needsReason: true,
    label: 'Lift hold',
  },
  void: {
    to: 'CANCELLED',
    lecturerFrom: [],
    adminFrom: ['ACTIVE', 'INTERRUPTED', 'COMPLETED'],
    adminPermission: 'class_sessions.void',
    needsReason: true,
    label: 'Void class',
  },
  reinstate: {
    to: 'SCHEDULED',
    lecturerFrom: [],
    adminFrom: ['CANCELLED'],
    adminPermission: 'class_sessions.void',
    needsReason: true,
    label: 'Reinstate class',
  },
  /** Applied only through an approved reschedule request or a direct reschedule (D-11). */
  reschedule: {
    to: 'RESCHEDULED',
    lecturerFrom: [],
    adminFrom: [...NOT_STARTED, 'SUSPENDED'],
    adminPermission: 'class_sessions.reschedule',
    needsReason: true,
    label: 'Reschedule class',
  },
  openReview: {
    to: 'UNDER_REVIEW',
    lecturerFrom: [],
    adminFrom: ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED'],
    adminPermission: 'class_reviews.decide',
    needsReason: true,
    label: 'Open a review',
  },
} as const satisfies Record<string, ClassAction>;

export type ClassActionName = keyof typeof CLASS_ACTIONS;

export const CANCEL_REASONS = [
  'LECTURER_UNAVAILABLE',
  'ILLNESS',
  'OFFICIAL_DUTY',
  'VENUE_UNAVAILABLE',
  'INSTITUTION_EVENT',
  'PUBLIC_HOLIDAY',
  'EMERGENCY',
  'LECTURER_ABSENT_NO_NOTICE',
  'OTHER',
] as const;

/** Only administrators may record that a lecturer was absent without notice. */
export const ADMIN_ONLY_CANCEL_REASONS = ['LECTURER_ABSENT_NO_NOTICE'] as const;

/** Rules on timing, in minutes (CLASS_LIFECYCLE.md §4). */
export const LIFECYCLE_TIMING = {
  /** Start class becomes available this long before the scheduled start. */
  startOpensBeforeMinutes: 15,
  /** A delayed class must still leave at least this long before the scheduled end. */
  minimumRemainingAfterDelayMinutes: 30,
} as const;

const NoteSchema = z.string().trim().min(5, 'explain briefly (at least 5 characters)').max(500);

export const DelayClassSchema = z.strictObject({
  minutes: z.number().int().min(5).max(240),
  reason: ReasonSchema,
});

export const CancelClassSchema = z
  .strictObject({ reasonCode: z.enum(CANCEL_REASONS), note: NoteSchema.optional() })
  .refine((v) => v.reasonCode !== 'OTHER' || v.note, {
    path: ['note'],
    message: 'is required when the reason is "Other"',
  });

export const VoidClassSchema = z.strictObject({
  reasonCode: z.enum(CANCEL_REASONS).default('OTHER'),
  reason: ReasonSchema,
});

export const ClassReasonSchema = z.strictObject({ reason: ReasonSchema });
