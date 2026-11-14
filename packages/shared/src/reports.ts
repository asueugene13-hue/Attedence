import { z } from 'zod';
import { IdSchema } from './admin.js';

/**
 * Reports and analytics (Phase 7). Everything is worked out from the records when asked, one semester
 * at a time (the active semester unless another is named), within the caller's scope. Attendance uses
 * the same rules as each student's own percentage (ATTENDANCE_FLOW §9).
 */

export const ATTENDANCE_GROUPS = [
  'faculty',
  'department',
  'programme',
  'level',
  'course',
  'lecturer',
] as const;
export type AttendanceGroup = (typeof ATTENDANCE_GROUPS)[number];
export const CLASS_GROUPS = ['faculty', 'department', 'course', 'lecturer'] as const;
export type ClassGroup = (typeof CLASS_GROUPS)[number];

export const AttendanceAnalyticsQuerySchema = z.strictObject({
  semesterId: IdSchema.optional(),
  groupBy: z.enum(ATTENDANCE_GROUPS).default('department'),
});
export const ClassAnalyticsQuerySchema = z.strictObject({
  semesterId: IdSchema.optional(),
  groupBy: z.enum(CLASS_GROUPS).default('department'),
});
