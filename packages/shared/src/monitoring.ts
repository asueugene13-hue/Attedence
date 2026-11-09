import { z } from 'zod';
import { ReasonSchema } from './admin.js';
import { CANCEL_REASONS } from './class-lifecycle.js';
import { RescheduleProposalSchema } from './reschedules.js';
import type { CLASS_STATUSES } from './timetables.js';

/**
 * Class monitoring (CLASS_MONITORING.md, Phase 3 step 5). The server watches every class; reports from
 * students, course reps and lecturers are evidence. Nothing here can cancel a class.
 */
export const ISSUE_TYPES = [
  'LECTURER_NOT_ARRIVED',
  'VERBAL_CANCELLATION',
  'CLASS_DELAYED',
  'WRONG_CLASSROOM',
  'VENUE_PROBLEM',
  'TIMETABLE_ERROR',
  'TECHNICAL_PROBLEM',
  'OTHER',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Reports that are evidence the class is not happening. Other types are shown, but never move a class. */
export const EVIDENCE_ISSUE_TYPES: readonly IssueType[] = [
  'LECTURER_NOT_ARRIVED',
  'VERBAL_CANCELLATION',
  'CLASS_DELAYED',
];

/** When and how often people may report (CLASS_MONITORING.md §2). */
export const REPORT_RULES = {
  /** Reports open this many minutes before the (expected) start and close at the scheduled end. */
  opensBeforeMinutes: 30,
  /** "Lecturer has not arrived" opens this many minutes after the (expected) start. */
  notArrivedAfterMinutes: 5,
  maxPerClass: 3,
  maxPerDay: 10,
} as const;

export const IssueReportSchema = z.strictObject({
  type: z.enum(ISSUE_TYPES),
  note: z.string().trim().min(1).max(500).optional(),
});

type Status = (typeof CLASS_STATUSES)[number];

/**
 * Changes the server makes by itself, on server time. Like CLASS_ACTIONS, each lists the statuses it
 * may happen from; the change is applied only if the class is still in that status.
 */
export const SYSTEM_TRANSITIONS = {
  markUnconfirmed: { from: ['SCHEDULED', 'POSTPONED'] as Status[], to: 'UNCONFIRMED' as Status },
  escalate: {
    from: ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED'] as Status[],
    to: 'UNDER_REVIEW' as Status,
  },
  /** A class still running at its scheduled end + LIFECYCLE_TIMING.autoEndAfterMinutes. */
  autoEnd: { from: ['ACTIVE'] as Status[], to: 'COMPLETED' as Status },
} as const;
export type SystemTransition = keyof typeof SYSTEM_TRANSITIONS;

export const REVIEW_DECISIONS = ['CLASS_HELD', 'CANCELLED', 'POSTPONED', 'RESCHEDULED', 'NO_ACTION'] as const;
export const REVIEW_STATUSES = ['OPEN', 'DECIDED'] as const;

/**
 * An administrator's review decision. Every decision needs a note. "Cancelled" needs a reason code,
 * "postponed" the delay in minutes from the scheduled start, "rescheduled" the new time and room.
 */
export const DecideReviewSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('CLASS_HELD'), note: ReasonSchema }),
  z.strictObject({ decision: z.literal('NO_ACTION'), note: ReasonSchema }),
  z.strictObject({
    decision: z.literal('CANCELLED'),
    note: ReasonSchema,
    reasonCode: z.enum(CANCEL_REASONS),
  }),
  z.strictObject({
    decision: z.literal('POSTPONED'),
    note: ReasonSchema,
    minutes: z.number().int().min(5).max(240),
  }),
  z.strictObject({
    decision: z.literal('RESCHEDULED'),
    note: ReasonSchema,
    reschedule: RescheduleProposalSchema,
  }),
]);

export const ReviewListQuerySchema = z.strictObject({
  status: z.enum(REVIEW_STATUSES).default('OPEN'),
});

export const DismissReportSchema = z.strictObject({ note: ReasonSchema });
