/**
 * Plain names for audit-log actions (Phase 7 step 4). The log stores a code such as
 * `attendance.corrected`; the screen shows "Attendance record corrected". Codes without an entry here
 * are shown from their parts ("Disputes: replied"), so a new action is never hidden.
 */
const NAMES: Record<string, string> = {
  'auth.login.succeeded': 'Signed in',
  'auth.login.failed': 'Sign-in failed',
  'auth.login.blocked_locked': 'Sign-in refused: account locked',
  'auth.account.locked': 'Account locked after failed sign-ins',
  'auth.account.activated': 'Account activated',
  'auth.password.changed': 'Password changed',
  'auth.password.reset': 'Password reset',
  'auth.mfa.enabled': 'Two-step sign-in set up',
  'auth.mfa.recovery_code_used': 'Recovery code used to sign in',
  'auth.role.switched': 'Switched role',
  'authz.denied': 'Access refused',
  'bootstrap.super_admin.created': 'First Super Admin created',
  'auth.logout': 'Signed out',
  'auth.refresh_token.reuse_detected': 'Stolen sign-in token suspected (sessions ended)',
  'users.created': 'Account created',
  'users.suspended': 'Account suspended',
  'users.role_granted': 'Role granted',
  'users.role_revoked': 'Role removed',
  'users.restored': 'Account restored',
  'roles.permissions_changed': 'Role permissions changed',
  'settings.changed': 'Setting changed',
  'audit_logs.searched': 'Audit log searched',
  'students.registered': 'Student registered',
  'students.updated': 'Student details changed',
  'students.status_changed': 'Student status changed',
  'enrollments.created': 'Student enrolled',
  'enrollments.ended': 'Enrolment ended',
  'imports.confirmed': 'Bulk import confirmed',
  'timetables.published': 'Timetable published',
  'class_sessions.start': 'Class started',
  'class_reviews.decided': 'Class review decided',
  'attendance.voided': 'Attendance voided (class voided)',
  'attendance.waiting_approved': 'Waiting check-ins approved together',
  'attendance.opened': 'Attendance opened',
  'attendance.closed': 'Attendance closed',
  'attendance.corrected': 'Attendance record corrected',
  'attendance.correction_requested': 'Late correction asked for',
  'attendance.check_in_approved': 'Check-in approved',
  'attendance.check_in_rejected': 'Check-in rejected',
  'attendance.assisted_check_in': 'Student checked in by the lecturer',
  'disputes.submitted': 'Dispute sent',
  'disputes.approved': 'Dispute approved',
  'disputes.rejected': 'Dispute rejected',
  'excuses.submitted': 'Excuse request sent',
  'excuses.approved': 'Excuse request approved',
  'excuses.rejected': 'Excuse request rejected',
  'excuses.applied': 'Class excused (after approval)',
  'announcements.sent': 'Announcement sent',
  'announcements.hidden': 'Announcement hidden',
  'student_ids.checked': 'Student ID checked',
  'risk_flags.reviewed': 'Risk flag reviewed',
  'devices.approved': 'Student phone approved',
  'devices.registered': 'Phone registered',
  'reports.export_requested': 'Report file asked for',
  'reports.export_ready': 'Report file made',
  'reports.export_downloaded': 'Report file downloaded',
  'reports.export_failed': 'Report file not made',
  'reports.export_expired': 'Report file deleted (retention)',
  'security.encryption_key_rotated': 'Encryption key changed (stored secrets re-encrypted)',
};

const AREAS: Record<string, string> = {
  auth: 'Sign-in',
  users: 'Accounts',
  roles: 'Roles',
  settings: 'Settings',
  audit_logs: 'Audit log',
  students: 'Students',
  imports: 'Imports',
  timetables: 'Timetables',
  class_sessions: 'Classes',
  attendance: 'Attendance',
  disputes: 'Disputes',
  excuses: 'Excuse requests',
  announcements: 'Announcements',
  student_ids: 'Student IDs',
  risk_flags: 'Risk flags',
  reports: 'Reports',
  devices: 'Phones',
  beacons: 'Beacons',
  security: 'Security',
};

export function describeAction(action: string): string {
  if (NAMES[action]) return NAMES[action];
  const dot = action.indexOf('.');
  const area = dot > 0 ? action.slice(0, dot) : action;
  const rest = dot > 0 ? action.slice(dot + 1).replaceAll(/[._]/g, ' ') : '';
  return `${AREAS[area] ?? area}${rest ? `: ${rest}` : ''}`;
}

/** Quick filters: an area's code prefix and its plain name. */
export const AUDIT_AREAS = Object.entries(AREAS).map(([prefix, label]) => ({ prefix: `${prefix}.`, label }));
