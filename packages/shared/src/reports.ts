import { z } from 'zod';
import { AuditLogQuerySchema, IdSchema } from './admin.js';

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

// ───────── Exports (Phase 7 step 2) ─────────
//
// A person asks for a report file; the worker makes it with that person's own access (checked again
// when it is made), stores it privately and says when it is ready. Files are kept for
// `reports.exportRetentionDays` (default 7); the export log itself is kept. Every request, every file
// made and every download is in the audit log. Spreadsheet cells that would run as formulas are
// neutralised.

export const REPORT_TYPES = [
  'SECTION_SUMMARY',
  'SECTION_REGISTER',
  'ATTENDANCE_ANALYTICS',
  'CLASS_OPERATIONS',
  'STUDENT_ENROLMENTS',
  'AUDIT_LOG',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const REPORT_LABELS: Record<ReportType, string> = {
  SECTION_SUMMARY: 'Class group attendance summary',
  SECTION_REGISTER: 'Class group attendance register',
  ATTENDANCE_ANALYTICS: 'Attendance analytics',
  CLASS_OPERATIONS: 'Class operations',
  STUDENT_ENROLMENTS: 'Students and enrolments',
  AUDIT_LOG: 'Audit log',
};

export const RequestExportSchema = z.discriminatedUnion('reportType', [
  z.strictObject({
    reportType: z.literal('SECTION_SUMMARY'),
    format: z.enum(EXPORT_FORMATS),
    params: z.strictObject({ sectionId: IdSchema }),
  }),
  z.strictObject({
    reportType: z.literal('SECTION_REGISTER'),
    format: z.enum(EXPORT_FORMATS),
    params: z.strictObject({ sectionId: IdSchema }),
  }),
  z.strictObject({
    reportType: z.literal('ATTENDANCE_ANALYTICS'),
    format: z.enum(EXPORT_FORMATS),
    params: AttendanceAnalyticsQuerySchema,
  }),
  z.strictObject({
    reportType: z.literal('CLASS_OPERATIONS'),
    format: z.enum(EXPORT_FORMATS),
    params: ClassAnalyticsQuerySchema,
  }),
  z.strictObject({
    reportType: z.literal('STUDENT_ENROLMENTS'),
    format: z.enum(EXPORT_FORMATS),
    params: z.strictObject({ semesterId: IdSchema.optional() }),
  }),
  z.strictObject({
    reportType: z.literal('AUDIT_LOG'),
    format: z.enum(EXPORT_FORMATS),
    /** The same filters as the audit search (no paging). */
    params: AuditLogQuerySchema.omit({ limit: true, cursor: true }),
  }),
]);
export type ExportRequest = z.output<typeof RequestExportSchema>;
