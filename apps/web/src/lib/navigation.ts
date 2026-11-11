import type { RoleKey } from '@attendsure/shared';

export interface NavItem {
  href: string;
  label: string;
  /** Shown only when the active role holds this permission (or any one of these). The API still checks every request. */
  permission?: string | readonly string[];
}

/**
 * Sidebar items. Only screens that exist are listed: no placeholders, no dead links.
 * Later phases add Attendance, Reports and so on, each behind its permission.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/today', label: 'Today', permission: 'class_sessions.start' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/classes', label: 'Class monitor', permission: 'class_reviews.decide' },
  { href: '/class-reviews', label: 'Class reviews', permission: 'class_reviews.decide' },
  {
    href: '/reschedule-requests',
    label: 'Reschedule requests',
    permission: ['class_sessions.reschedule', 'class_sessions.request_reschedule'],
  },
  { href: '/timetables', label: 'Timetables', permission: 'timetables.manage' },
  { href: '/students', label: 'Students', permission: 'students.read_full' },
  { href: '/imports', label: 'Bulk import', permission: ['students.import', 'enrollments.manage'] },
  { href: '/enrollments', label: 'Enrolments', permission: 'enrollments.manage' },
  { href: '/devices', label: 'Phones', permission: 'devices.approve' },
  { href: '/risk-flags', label: 'Risk flags', permission: 'risk_flags.review' },
  { href: '/setup/courses', label: 'Courses', permission: 'academic_structure.read' },
  { href: '/setup/lecturers', label: 'Lecturers', permission: 'academic_structure.read' },
  { href: '/setup/structure', label: 'Academic structure', permission: 'academic_structure.read' },
  { href: '/setup/calendar', label: 'Academic calendar', permission: 'academic_structure.read' },
  { href: '/setup/places', label: 'Places', permission: 'classrooms.manage' },
  { href: '/beacons', label: 'Beacons', permission: 'beacons.manage' },
  { href: '/admin/users', label: 'Accounts', permission: 'users.manage_admins' },
  { href: '/admin/roles', label: 'Roles and permissions', permission: 'roles.edit_permissions' },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit_logs.read' },
  { href: '/admin/settings', label: 'Settings', permission: 'settings.manage' },
  {
    href: '/admin/verification-policy',
    label: 'Verification policy',
    permission: 'verification_policies.manage',
  },
  { href: '/admin/system-health', label: 'System health', permission: 'system_health.read' },
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
