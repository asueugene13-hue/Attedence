/**
 * The six AttendSure roles. These keys are stored in the database (Role.key) and in access tokens,
 * so renaming one is a breaking change that needs a migration.
 */
export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'UNIVERSITY_ADMIN',
  'REGISTRAR',
  'LECTURER',
  'STUDENT',
  'COURSE_REP',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  UNIVERSITY_ADMIN: 'University Administrator',
  REGISTRAR: 'Registrar',
  LECTURER: 'Lecturer',
  STUDENT: 'Student',
  COURSE_REP: 'Course Representative',
};

/**
 * Staff roles that must use two-factor sign-in (decision D-03, approved 2026-11-08).
 */
export const MFA_REQUIRED_ROLES: readonly RoleKey[] = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN', 'REGISTRAR'];

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === 'string' && (ROLE_KEYS as readonly string[]).includes(value);
}
