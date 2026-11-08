import { z } from 'zod';
import { NameSchema } from './academic.js';
import { GhanaPhoneSchema } from './admin.js';
import { STUDENT_STATUSES, StudentNumberSchema } from './students.js';

/**
 * Bulk import (Phase 2, step 5). A file is checked row by row and shown as a preview; nothing is saved
 * until a person confirms it. Limits keep one import inside a single all-or-nothing transaction.
 */
export const IMPORT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 5000,
} as const;

/** Profile photos: JPEG or PNG, checked from the file's bytes. */
export const PHOTO_LIMITS = { maxFileBytes: 2 * 1024 * 1024 } as const;

export const IMPORT_TYPES = ['STUDENTS', 'ENROLLMENTS'] as const;
export const IMPORT_STATUSES = ['VALIDATED', 'IMPORTING', 'COMPLETED', 'CANCELLED'] as const;
export const IMPORT_ROW_STATUSES = [
  'VALID',
  'INVALID',
  'DUPLICATE_IN_FILE',
  'DUPLICATE_EXISTING',
  'IMPORTED',
] as const;

/**
 * Columns of the student import template, in order. Codes and labels are the ones staff entered in the
 * academic structure, so the file uses names people recognise rather than internal IDs.
 */
export const STUDENT_IMPORT_COLUMNS = [
  { key: 'student_number', required: true, hint: '8-digit Student ID' },
  { key: 'full_name', required: true, hint: 'As on admission documents' },
  { key: 'email', required: true, hint: 'Where the activation link is sent' },
  { key: 'phone', required: true, hint: 'Ghana number, e.g. 024xxxxxxx or +23324xxxxxxx' },
  { key: 'programme_code', required: true, hint: 'Programme code from the academic structure' },
  { key: 'level_code', required: true, hint: 'Level code from the academic structure' },
  { key: 'academic_year', required: true, hint: 'Academic year label, exactly as entered' },
  { key: 'semester_number', required: true, hint: 'Semester number within that year' },
  { key: 'status', required: false, hint: `Optional: ${STUDENT_STATUSES.join(', ')} (default ACTIVE)` },
] as const;
export type StudentImportColumn = (typeof STUDENT_IMPORT_COLUMNS)[number]['key'];

const code = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(20)
  .transform((v) => v.toUpperCase());

/** One spreadsheet row, after the column names are mapped. Lookups by code happen in the API. */
export const StudentImportRowSchema = z.object({
  student_number: StudentNumberSchema,
  full_name: NameSchema,
  email: z
    .string()
    .trim()
    .pipe(z.email('must be a valid email').max(254))
    .transform((v) => v.toLowerCase()),
  phone: GhanaPhoneSchema,
  programme_code: code,
  level_code: code,
  academic_year: z.string().trim().min(1, 'is required').max(50),
  semester_number: z.coerce.number('must be a number').int('must be a whole number').min(1).max(4),
  status: z
    .string()
    .trim()
    .transform((v) => (v === '' ? 'ACTIVE' : v.toUpperCase()))
    .pipe(z.enum(STUDENT_STATUSES, `must be one of ${STUDENT_STATUSES.join(', ')}`)),
});

export const ImportFormatQuerySchema = z.strictObject({
  format: z.enum(['csv', 'xlsx']).default('csv'),
});

export const ImportListQuerySchema = z.strictObject({
  status: z.enum(IMPORT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

export const ImportRowsQuerySchema = z.strictObject({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** The last row number already shown. */
  after: z.coerce.number().int().min(1).optional(),
});
