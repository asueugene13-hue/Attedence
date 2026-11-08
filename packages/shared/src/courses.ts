import { z } from 'zod';
import { CodeSchema, NameSchema } from './academic.js';
import { ReasonSchema } from './admin.js';

/**
 * Request shapes for courses, offerings, sections, lecturers and lecturer assignments (Phase 2, step 3).
 */

export const CreateCourseSchema = z.strictObject({
  departmentId: z.uuid(),
  code: CodeSchema,
  title: NameSchema,
  creditHours: z.number().int().min(0).max(60).optional(),
});
export const UpdateCourseSchema = z.strictObject({
  code: CodeSchema.optional(),
  title: NameSchema.optional(),
  creditHours: z.number().int().min(0).max(60).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const CreateOfferingSchema = z.strictObject({ courseId: z.uuid(), semesterId: z.uuid() });

export const CreateSectionSchema = z.strictObject({
  offeringId: z.uuid(),
  code: CodeSchema,
  name: NameSchema.optional(),
  capacity: z.number().int().min(1).max(5000).optional(),
  programmeId: z.uuid().optional(),
  levelId: z.uuid().optional(),
});
export const UpdateSectionSchema = z.strictObject({
  name: NameSchema.nullable().optional(),
  capacity: z.number().int().min(1).max(5000).nullable().optional(),
  programmeId: z.uuid().nullable().optional(),
  levelId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Staff numbers: the university's real format is still to be confirmed (decision D-14), so any
 * reasonable identifier is accepted for now and stored in capitals.
 */
export const StaffNumberSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/_-]{0,29}$/, 'use 1–30 letters, digits, /, - or _'));

const STAFF_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INACTIVE'] as const;

export const CreateLecturerSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  fullName: z.string().trim().min(2).max(200),
  staffNumber: StaffNumberSchema,
  departmentId: z.uuid(),
  title: z.string().trim().min(1).max(40).optional(),
});
export const UpdateLecturerSchema = z.strictObject({
  staffNumber: StaffNumberSchema.optional(),
  departmentId: z.uuid().optional(),
  title: z.string().trim().min(1).max(40).nullable().optional(),
  status: z.enum(STAFF_STATUSES).optional(),
});

export const AssignLecturerSchema = z.strictObject({
  lecturerId: z.uuid(),
  isPrimary: z.boolean().default(true),
});
export const EndAssignmentSchema = z.strictObject({ reason: ReasonSchema });

export const CourseQuerySchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  q: z.string().trim().min(1).max(100).optional(),
  departmentId: z.uuid().optional(),
  facultyId: z.uuid().optional(),
  semesterId: z.uuid().optional(),
  courseId: z.uuid().optional(),
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED', ...STAFF_STATUSES]).optional(),
});
