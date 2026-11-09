import type { RoleKey } from '@attendsure/shared';

export interface NavItem {
  href: string;
  label: string;
  /** Shown only when the active role holds this permission (or any one of these). The API still checks every request. */
  permission?: string | readonly string[];
}

/**
 * Sidebar items. Only screens that exist are listed: no placeholders, no dead links.
 * Later phases add Timetable, Classes, Reports and so on, each behind its permission.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/students', label: 'Students', permission: 'students.read_full' },
  { href: '/imports', label: 'Bulk import', permission: ['students.import', 'enrollments.manage'] },
  { href: '/enrollments', label: 'Enrolments', permission: 'enrollments.manage' },
  { href: '/setup/courses', label: 'Courses', permission: 'academic_structure.read' },
  { href: '/setup/lecturers', label: 'Lecturers', permission: 'academic_structure.read' },
  { href: '/setup/structure', label: 'Academic structure', permission: 'academic_structure.read' },
  { href: '/setup/calendar', label: 'Academic calendar', permission: 'academic_structure.read' },
  { href: '/setup/places', label: 'Places', permission: 'classrooms.manage' },
  { href: '/admin/users', label: 'Accounts', permission: 'users.manage_admins' },
  { href: '/admin/roles', label: 'Roles and permissions', permission: 'roles.edit_permissions' },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit_logs.read' },
];

export function visibleNavItems(permissions: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (!item.permission) return true;
    const needed = typeof item.permission === 'string' ? [item.permission] : item.permission;
    return needed.some((p) => permissions.includes(p));
  });
}

/** Roles that use the mobile app rather than the dashboard for their daily work. */
export const MOBILE_FIRST_ROLES: readonly RoleKey[] = ['STUDENT', 'COURSE_REP'];
