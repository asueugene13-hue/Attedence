import { z } from 'zod';
import { ReasonSchema } from './admin.js';

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
