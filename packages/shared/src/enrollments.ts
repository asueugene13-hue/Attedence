import { z } from 'zod';
import { ReasonSchema } from './admin.js';
import { StudentNumberSchema } from './students.js';

/**
 * Enrolments (a student in one section of a course offering) and course-rep assignments
 * (Phase 2, step 6). A student holds at most one active enrolment per offering.
 */
export const ENROLLMENT_STATUSES = ['ENROLLED', 'DROPPED', 'WITHDRAWN'] as const;

export const EnrollSchema = z.strictObject({
  studentId: z.uuid(),
  sectionId: z.uuid(),
});

export const EndEnrollmentSchema = z.strictObject({
  /** DROPPED: removed from the course. WITHDRAWN: the student left it. */
  status: z.enum(['DROPPED', 'WITHDRAWN']).default('DROPPED'),
  reason: ReasonSchema,
});

export const EnrollmentQuerySchema = z.strictObject({
  sectionId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  studentId: z.uuid().optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

/** Columns of the enrolment import template, in order. */
export const ENROLLMENT_IMPORT_COLUMNS = [
  { key: 'student_number', required: true, hint: '8-digit Student ID of a registered student' },
  { key: 'course_code', required: true, hint: 'Course code' },
  { key: 'academic_year', required: true, hint: 'Academic year label, exactly as entered' },
  { key: 'semester_number', required: true, hint: 'Semester number within that year' },
  { key: 'section_code', required: true, hint: 'Section code within that course offering' },
] as const;

const code = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(20)
  .transform((v) => v.toUpperCase());

export const EnrollmentImportRowSchema = z.object({
  student_number: StudentNumberSchema,
  course_code: code,
  academic_year: z.string().trim().min(1, 'is required').max(50),
  semester_number: z.coerce.number('must be a number').int('must be a whole number').min(1).max(4),
  section_code: code,
});

export const COURSE_REP_STATUSES = ['NOMINATED', 'ACTIVE', 'ENDED', 'REJECTED'] as const;

/** An administrator appoints directly (decision D-12). */
export const AppointCourseRepSchema = z.strictObject({
  studentId: z.uuid(),
  reason: ReasonSchema.optional(),
});

/** A lecturer of the section proposes a student; an administrator approves or rejects. */
export const NominateCourseRepSchema = z.strictObject({
  studentId: z.uuid(),
  note: z.string().trim().min(5, 'explain briefly (at least 5 characters)').max(500).optional(),
});
