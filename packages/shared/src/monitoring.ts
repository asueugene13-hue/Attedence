import { z } from 'zod';
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
} as const;
export type SystemTransition = keyof typeof SYSTEM_TRANSITIONS;
