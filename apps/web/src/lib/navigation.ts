import type { RoleKey } from '@attendsure/shared';

export interface NavItem {
  href: string;
  label: string;
  /** Shown only when the active role holds this permission. The API still checks every request. */
  permission?: string;
}

/**
 * Sidebar items. Only screens that exist are listed: no placeholders, no dead links.
 * Later phases add Timetable, Classes, Students, Reports and so on, each behind its permission.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/admin/users', label: 'Accounts', permission: 'users.manage_admins' },
  { href: '/admin/roles', label: 'Roles and permissions', permission: 'roles.edit_permissions' },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit_logs.read' },
];

export function visibleNavItems(permissions: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.permission || permissions.includes(item.permission));
}

/** Roles that use the mobile app rather than the dashboard for their daily work. */
export const MOBILE_FIRST_ROLES: readonly RoleKey[] = ['STUDENT', 'COURSE_REP'];
