import type { RoleKey } from '@attendsure/shared';

export type TabName = 'Home' | 'Schedule' | 'Alerts' | 'Profile';

/**
 * Bottom tabs per role. Only screens that exist are listed: no placeholder tabs. Later phases add
 * Scan and Attendance for students and Live and Reviews for lecturers (design canvas: information
 * architecture), each when it works.
 */
export function tabsForRole(role: RoleKey): TabName[] {
  switch (role) {
    case 'STUDENT':
    case 'COURSE_REP':
    case 'LECTURER':
      return ['Home', 'Schedule', 'Alerts', 'Profile'];
    case 'SUPER_ADMIN':
    case 'UNIVERSITY_ADMIN':
    case 'REGISTRAR':
      return ['Home', 'Alerts', 'Profile'];
  }
}

/** Staff administration happens on the web dashboard; the app tells them so. */
export const WEB_DASHBOARD_ROLES: readonly RoleKey[] = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN', 'REGISTRAR'];
