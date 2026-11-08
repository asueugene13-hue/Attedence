import { z } from 'zod';
import { PERMISSION_KEYS, type PermissionKey } from './permissions.js';
import { ROLE_KEYS, type RoleKey } from './roles.js';

/**
 * Request shapes for the Super Admin API (Phase 1 step 6). Unknown fields are rejected.
 */

/**
 * Roles granted through the account screens. Lecturers, students and course reps are created with their
 * academic records (Phase 2: lecturer profiles, Registrar registration, course-rep assignments).
 */
export const STAFF_ADMIN_ROLES = [
  'SUPER_ADMIN',
  'UNIVERSITY_ADMIN',
  'REGISTRAR',
] as const satisfies readonly RoleKey[];
export type StaffAdminRole = (typeof STAFF_ADMIN_ROLES)[number];

/** Sensitive actions need a short explanation that goes into the audit log. */
export const ReasonSchema = z.string().trim().min(5, 'explain briefly (at least 5 characters)').max(500);

export const IdSchema = z.uuid();

const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/** Ghana numbers: 0XXXXXXXXX or +233XXXXXXXXX (spaces allowed, removed). */
export const GhanaPhoneSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(
    z.string().regex(/^(?:0|\+233)\d{9}$/, 'must be a Ghana number, e.g. 024 555 0123 or +233 24 555 0123'),
  );

const roleGrantFields = {
  role: z.enum(STAFF_ADMIN_ROLES),
  /** University Administrators may be limited to one faculty or department; other roles are university-wide. */
  scopeType: z.enum(['INSTITUTION', 'FACULTY', 'DEPARTMENT']).default('INSTITUTION'),
  scopeId: z.uuid().optional(),
};

type GrantShape = {
  role: StaffAdminRole;
  scopeType: 'INSTITUTION' | 'FACULTY' | 'DEPARTMENT';
  scopeId?: string | undefined;
};
const scopeRules = <T extends GrantShape>(v: T, ctx: z.RefinementCtx) => {
  if (v.scopeType !== 'INSTITUTION' && v.role !== 'UNIVERSITY_ADMIN') {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeType'],
      message: 'only University Administrators can be limited to a faculty or department',
    });
  }
  if ((v.scopeType === 'INSTITUTION') !== (v.scopeId === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeId'],
      message: 'give scopeId exactly when scopeType is FACULTY or DEPARTMENT',
    });
  }
};

export const RoleGrantSchema = z.strictObject(roleGrantFields).superRefine(scopeRules);

export const CreateStaffUserSchema = z.strictObject({
  email,
  fullName: z.string().trim().min(2).max(200),
  phone: GhanaPhoneSchema.optional(),
  roles: z.array(RoleGrantSchema).min(1).max(3),
  reason: ReasonSchema.optional(),
});
export type CreateStaffUser = z.infer<typeof CreateStaffUserSchema>;

export const GrantRoleSchema = z
  .strictObject({ ...roleGrantFields, reason: ReasonSchema })
  .superRefine(scopeRules);
export const ReasonOnlySchema = z.strictObject({ reason: ReasonSchema });

export const UserListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: IdSchema.optional(),
});

export const ReplaceRolePermissionsSchema = z.strictObject({
  permissions: z
    .array(z.string())
    .max(PERMISSION_KEYS.length)
    .refine((keys) => new Set(keys).size === keys.length, 'list each permission once')
    .transform((keys) => keys as PermissionKey[]),
  reason: ReasonSchema,
});

const isoDate = z.iso.datetime({ offset: true });

export const AuditLogQuerySchema = z.strictObject({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(100).optional(),
  actorUserId: IdSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: IdSchema.optional(),
});
