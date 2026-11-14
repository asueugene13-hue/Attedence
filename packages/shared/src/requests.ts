import { z } from 'zod';
import { IdSchema } from './admin.js';

/**
 * Requests from students (Phase 6): disputes now, excuse requests next. Decision D-21 (product owner,
 * 2026-11-14): a student may dispute a record within a set number of days of the class (setting
 * `requests.disputeDays`, default 14); the class's lecturer decides; if it is still undecided after
 * 72 hours, the administrators responsible are told. Nothing is ever decided automatically.
 */

/** Only these records can be disputed: the student says they were there. */
export const DISPUTABLE_STATUSES = ['ABSENT', 'REJECTED'] as const;
/** What an approved dispute can change the record to; the reviewer chooses. */
export const DISPUTE_OUTCOMES = ['PRESENT', 'LATE'] as const;

export const DISPUTE_STATUSES = ['SUBMITTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
/** Still open: waiting for the reviewer (SUBMITTED) or for the student's answer (INFO_REQUESTED). */
export const OPEN_DISPUTE_STATUSES = ['SUBMITTED', 'INFO_REQUESTED'] as const satisfies DisputeStatus[];

/** Hours a dispute may wait for a reviewer before the administrators responsible are told (D-21). */
export const DISPUTE_ESCALATE_AFTER_HOURS = 72;

/** Supporting files for disputes and excuse requests: type checked from the file's bytes. */
export const REQUEST_ATTACHMENT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 3,
  types: ['application/pdf', 'image/jpeg', 'image/png'],
} as const;

const Text = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .min(min, `${what} is too short (at least ${min} characters)`)
    .max(max, `${what} is too long (at most ${max} characters)`);

export const SubmitDisputeSchema = z.strictObject({
  /** The class whose record is disputed; the server finds the student's own record. */
  classSessionId: IdSchema,
  reason: Text(10, 2000, 'The explanation'),
});

export const DisputeListQuerySchema = z.strictObject({
  /** OPEN (default): still waiting; DECIDED: approved or rejected; ALL: including withdrawn. */
  state: z.enum(['OPEN', 'DECIDED', 'ALL']).default('OPEN'),
});

/** The reviewer asks the student something; the dispute waits for the answer. */
export const DisputeQuestionSchema = z.strictObject({ question: Text(5, 1000, 'The question') });
/** The student's answer; the dispute goes back to the reviewer. */
export const DisputeReplySchema = z.strictObject({ reply: Text(2, 2000, 'The reply') });

export const ApproveDisputeSchema = z.strictObject({
  status: z.enum(DISPUTE_OUTCOMES),
  note: Text(2, 1000, 'The note').optional(),
});
export const RejectDisputeSchema = z.strictObject({ note: Text(5, 1000, 'The note') });
