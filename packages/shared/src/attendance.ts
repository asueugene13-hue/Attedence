import { z } from 'zod';
import { ReasonSchema } from './admin.js';
import { ClassroomCheckSchema } from './verification.js';

/**
 * Attendance (Phase 5, ATTENDANCE_FLOW.md). The server decides; clients only collect evidence and
 * show results.
 */

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'LATE',
  'PENDING',
  'UNDER_REVIEW',
  'REJECTED',
  'ABSENT',
  'EXCUSED',
  'VOIDED',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/**
 * §4: records only move up. A check-in can raise a record to a higher rank, never lower it; only an
 * audited correction can lower one. EXCUSED and VOIDED are set by their own workflows only.
 */
export const RECORD_RANK: Record<AttendanceStatus, number> = {
  ABSENT: 0,
  REJECTED: 1,
  PENDING: 2,
  UNDER_REVIEW: 3,
  LATE: 4,
  PRESENT: 4,
  EXCUSED: 5,
  VOIDED: 6,
};

/** Dynamic QR (PRESENCE_VERIFICATION §2): attendance tokens start with this; student ID codes do not. */
export const ATTENDANCE_QR_PREFIX = 'AS1';

/**
 * A check-in (ATTENDANCE_FLOW §2), signed by the phone, with an `Idempotency-Key` header (a UUID).
 * The same evidence as "Check this classroom", plus the scanned QR text; the room comes from the QR.
 */
export const CheckInSchema = ClassroomCheckSchema.omit({ classroomId: true }).extend({
  qrToken: z.string().trim().min(1).max(200),
  appVersion: z.string().trim().max(40).optional(),
});

/** Opening attendance: the class can be started in the same tap (§1). Times default to the settings. */
export const OpenAttendanceSchema = z.strictObject({
  /** Start the class too, if it has not started (one tap). */
  startClass: z.boolean().default(true),
  lateAfterMinutes: z.number().int().min(0).max(120).optional(),
  closeAfterMinutes: z.number().int().min(5).max(240).optional(),
});

/** The lecturer closes early (no reason needed); an administrator force-closes with a reason. */
export const CloseAttendanceSchema = z.strictObject({ reason: ReasonSchema.optional() });

export const ExtendAttendanceSchema = z.strictObject({
  minutes: z.number().int().min(1).max(60),
  reason: ReasonSchema,
});

/** Reopening is allowed once, before the scheduled end, with a reason. */
export const ReopenAttendanceSchema = z.strictObject({
  reason: ReasonSchema,
  minutes: z.number().int().min(1).max(60).default(10),
});

/** A lecturer's (or administrator's) decision on a waiting check-in: a note is required to reject. */
export const DecideRecordSchema = z
  .strictObject({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: ReasonSchema.optional(),
    /** The record's version as shown, so two reviewers cannot overwrite each other. */
    version: z.number().int().min(0),
  })
  .refine((v) => v.decision === 'APPROVE' || v.note !== undefined, {
    path: ['note'],
    message: 'Say why the check-in is rejected.',
  });

/** Degraded mode only: approve every check-in that waits only because the beacon was not working. */
export const ApproveWaitingSchema = z.strictObject({ note: ReasonSchema.optional() });

export const ASSIST_METHODS = [
  'PHONE_UNAVAILABLE',
  'NO_SMARTPHONE',
  'BEACON_FAILURE',
  'LATE_ENROLMENT',
  'OTHER',
] as const;
export const ASSIST_METHOD_LABELS: Record<(typeof ASSIST_METHODS)[number], string> = {
  PHONE_UNAVAILABLE: 'Phone dead, lost or broken',
  NO_SMARTPHONE: 'No smartphone',
  BEACON_FAILURE: 'Classroom beacon not working',
  LATE_ENROLMENT: 'Enrolled after the class started',
  OTHER: 'Other (explain)',
};

/** The lecturer checks a student in by hand, with how and why (ATTENDANCE_FLOW §7). */
export const AssistedCheckInSchema = z.strictObject({
  studentId: z.uuid(),
  method: z.enum(ASSIST_METHODS),
  reason: ReasonSchema,
});

/** Live roster events (ATTENDANCE_FLOW §6): each carries an increasing `seq`; on a gap, reload the roster. */
export const ATTENDANCE_EVENT = 'attendance';
export type AttendanceEventType = 'record.updated' | 'session.updated';

/**
 * Correcting a record (ATTENDANCE_FLOW §7) with a reason. Only these outcomes are set by a
 * correction: excuses (EXCUSED) and voided classes (VOIDED) have their own workflows, and waiting
 * check-ins are approved or rejected instead.
 */
export const CORRECTABLE_STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'REJECTED'] as const;
export const CorrectRecordSchema = z.strictObject({
  status: z.enum(CORRECTABLE_STATUSES),
  reason: ReasonSchema,
  version: z.number().int().min(0),
});

/** An administrator's decision on a lecturer's late correction: a note is required to reject. */
export const DecideCorrectionRequestSchema = z
  .strictObject({ decision: z.enum(['APPROVE', 'REJECT']), note: ReasonSchema.optional() })
  .refine((v) => v.decision === 'APPROVE' || v.note !== undefined, {
    path: ['note'],
    message: 'Say why the correction is rejected.',
  });

export const CorrectionRequestQuerySchema = z.strictObject({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
});

/** §5: check-ins still undecided this long after attendance closed go to an administrator. */
export const UNDECIDED_ESCALATE_AFTER_HOURS = 72;
/** §5: the lecturer is reminded at the class's end and at this hour (local time) the next morning. */
export const UNDECIDED_MORNING_REMINDER_HOUR = 8;
