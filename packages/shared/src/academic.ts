import { z } from 'zod';

/**
 * Request shapes for the academic structure (Phase 2, step 1). Unknown fields are rejected.
 * Codes and names are whatever the university uses; nothing about Knutsford is assumed here.
 */

/** Short identifiers such as a faculty or course code: letters, digits, '-' or '_', stored in capitals. */
export const CodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'use 1–20 letters, digits, - or _'));

export const NameSchema = z.string().trim().min(2, 'must be at least 2 characters').max(200);

/** A calendar date, written YYYY-MM-DD (no time of day). */
export const DateOnlySchema = z.iso.date('must be a date written YYYY-MM-DD');

const optionalBool = z.boolean().optional();

export const CreateFacultySchema = z.strictObject({ code: CodeSchema, name: NameSchema });
export const UpdateFacultySchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  isActive: optionalBool,
});

export const CreateDepartmentSchema = z.strictObject({
  facultyId: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
});
export const UpdateDepartmentSchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  isActive: optionalBool,
});

export const CreateProgrammeSchema = z.strictObject({
  departmentId: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  qualification: z.string().trim().min(2).max(200).optional(),
  durationYears: z.number().int().min(1).max(10).optional(),
});
export const UpdateProgrammeSchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  qualification: z.string().trim().min(2).max(200).nullable().optional(),
  durationYears: z.number().int().min(1).max(10).nullable().optional(),
  isActive: optionalBool,
});

export const CreateLevelSchema = z.strictObject({
  code: CodeSchema,
  name: NameSchema,
  sortOrder: z.number().int().min(0).max(1000),
});
export const UpdateLevelSchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isActive: optionalBool,
});

const endAfterStart = { message: 'endDate must be after startDate', path: ['endDate'] };

export const CreateAcademicYearSchema = z
  .strictObject({
    label: z.string().trim().min(2).max(40),
    startDate: DateOnlySchema,
    endDate: DateOnlySchema,
  })
  .refine((v) => v.endDate > v.startDate, endAfterStart);
export const UpdateAcademicYearSchema = z
  .strictObject({
    label: z.string().trim().min(2).max(40).optional(),
    startDate: DateOnlySchema.optional(),
    endDate: DateOnlySchema.optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate > v.startDate, {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  });

export const CreateSemesterSchema = z
  .strictObject({
    academicYearId: z.uuid(),
    number: z.number().int().min(1).max(4),
    name: NameSchema,
    startDate: DateOnlySchema,
    endDate: DateOnlySchema,
  })
  .refine((v) => v.endDate > v.startDate, endAfterStart);
export const UpdateSemesterSchema = z
  .strictObject({
    name: NameSchema.optional(),
    startDate: DateOnlySchema.optional(),
    endDate: DateOnlySchema.optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate > v.startDate, {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  });

export const CALENDAR_EXCEPTION_TYPES = [
  'PUBLIC_HOLIDAY',
  'UNIVERSITY_CLOSURE',
  'EXAM_PERIOD',
  'OTHER',
] as const;

export const CreateCalendarExceptionSchema = z
  .strictObject({
    semesterId: z.uuid().optional(),
    type: z.enum(CALENDAR_EXCEPTION_TYPES),
    name: NameSchema,
    startDate: DateOnlySchema,
    endDate: DateOnlySchema,
    suppressesClasses: z.boolean().default(true),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'endDate cannot be before startDate',
    path: ['endDate'],
  });

export const ListQuerySchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  facultyId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
  semesterId: z.uuid().optional(),
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
});
