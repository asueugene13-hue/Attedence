import { z } from 'zod';
import { NameSchema } from './academic.js';
import { GhanaPhoneSchema, ReasonSchema } from './admin.js';

/**
 * Request shapes for student registration (Phase 2, step 4).
 *
 * Student ID format: 8 digits, as confirmed by the product owner (2026-11-08). Only the shape is
 * checked; the meaning of individual digits is not assumed.
 */
export const STUDENT_NUMBER_PATTERN = /^\d{8}$/;
export const StudentNumberSchema = z
  .string()
  .trim()
  .regex(STUDENT_NUMBER_PATTERN, 'must be the 8-digit Student ID');

export const STUDENT_STATUSES = ['ACTIVE', 'DEFERRED', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'] as const;

const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

export const CreateStudentSchema = z.strictObject({
  studentNumber: StudentNumberSchema,
  fullName: NameSchema,
  email,
  phone: GhanaPhoneSchema,
  programmeId: z.uuid(),
  /** Optional cross-checks: when sent, they must match the programme's department and faculty. */
  departmentId: z.uuid().optional(),
  facultyId: z.uuid().optional(),
  levelId: z.uuid(),
  academicYearId: z.uuid(),
  semesterId: z.uuid(),
  status: z.enum(STUDENT_STATUSES).default('ACTIVE'),
});
export type CreateStudent = z.output<typeof CreateStudentSchema>;

export const UpdateStudentSchema = z.strictObject({
  fullName: NameSchema.optional(),
  phone: GhanaPhoneSchema.optional(),
  programmeId: z.uuid().optional(),
  levelId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
  semesterId: z.uuid().optional(),
  noDeviceExemption: z.boolean().optional(),
});

export const StudentStatusChangeSchema = z.strictObject({
  status: z.enum(STUDENT_STATUSES),
  reason: ReasonSchema,
});

export const StudentQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  facultyId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  programmeId: z.uuid().optional(),
  levelId: z.uuid().optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
