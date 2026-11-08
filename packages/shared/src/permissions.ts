import type { RoleKey } from './roles.js';

/**
 * Permission catalogue and default role grants, taken from docs/ROLE_PERMISSION_MATRIX.md.
 *
 * - A permission says WHAT a role may do. WHERE it may do it (which faculty, department or section)
 *   is checked separately by scope policies in the API.
 * - "Protected" permissions can only ever be held by SUPER_ADMIN.
 * - DEFAULT_ROLE_PERMISSIONS is what the Phase 1 seed gives each role. CONFIGURABLE_ROLE_PERMISSIONS
 *   lists the extra grants the Super Admin may switch on (the "C" cells in the matrix).
 */
export const PERMISSIONS = {
  // Accounts and system
  'users.manage_admins': { description: 'Create and manage administrator accounts', protected: true },
  'roles.assign': { description: 'Assign and revoke staff roles', protected: true },
  'roles.edit_permissions': { description: 'Change which permissions a role holds', protected: true },
  'settings.manage': { description: 'System, notification and security settings', protected: true },
  'accounts.suspend': { description: 'Suspend or restore accounts', protected: false },
  'verification_policies.manage': { description: 'Verification policies and thresholds', protected: false },
  'monitoring_thresholds.manage': { description: 'Class-monitoring thresholds', protected: false },
  'system_health.read': { description: 'View system health', protected: false },
  'audit_logs.read': { description: 'View audit logs', protected: false },
  'risk_flags.review': { description: 'Review and resolve risk flags', protected: false },
  'risk_flags.read': { description: 'View risk flags for own sessions', protected: false },

  // Academic structure
  'academic_structure.manage': {
    description: 'Faculties, departments, programmes, levels',
    protected: false,
  },
  'academic_structure.read': { description: 'View the academic structure', protected: false },
  'academic_periods.manage': {
    description: 'Academic years, semesters, holidays and closures',
    protected: false,
  },
  'courses.manage': { description: 'Courses, offerings and sections', protected: false },
  'lecturers.manage': { description: 'Lecturer accounts and profiles', protected: false },
  'lecturer_assignments.manage': { description: 'Assign lecturers to sections', protected: false },
  'course_reps.assign': { description: 'Appoint or end course-rep assignments', protected: false },
  'course_reps.nominate': { description: 'Nominate a course rep for approval', protected: false },

  // Students
  'students.create': { description: 'Register a student', protected: false },
  'students.import': { description: 'Bulk import students', protected: false },
  'students.update': { description: 'Edit student details and academic status', protected: false },
  'students.read_full': { description: 'View a full student record', protected: false },
  'enrollments.manage': { description: 'Manage course enrolments', protected: false },
  'class_lists.read': { description: "View a section's class list", protected: false },
  'devices.approve': { description: 'Approve or revoke a student attendance phone', protected: false },
  'devices.request_replacement': { description: 'Request a replacement attendance phone', protected: false },

  // Places and timetable
  'classrooms.manage': { description: 'Campuses, buildings and classrooms', protected: false },
  'beacons.manage': { description: 'Register and manage BLE beacons', protected: false },
  'beacon_health.read': { description: 'View beacon health', protected: false },
  'timetables.manage': { description: 'Create and edit timetables', protected: false },
  'timetables.publish': { description: 'Publish timetables', protected: false },
  'timetables.read': { description: 'View timetables', protected: false },

  // Class operations
  'class_sessions.start': { description: 'Confirm, start and end own classes', protected: false },
  'class_sessions.delay': { description: 'Report a class delay', protected: false },
  'class_sessions.cancel': { description: 'Cancel a class before attendance opens', protected: false },
  'class_sessions.void': { description: 'Cancel or void a class after attendance started', protected: false },
  'class_sessions.request_void': { description: 'Request that a class be voided', protected: false },
  'class_sessions.reschedule': { description: 'Reschedule a class or approve a request', protected: false },
  'class_sessions.request_reschedule': { description: 'Request a reschedule', protected: false },
  'class_sessions.suspend': { description: 'Suspend or reinstate class sessions', protected: false },
  'class_issues.report': { description: 'Report a class issue', protected: false },
  'makeup.suggest': { description: 'Suggest make-up class times', protected: false },
  'class_reviews.decide': { description: 'Decide a class under review', protected: false },

  // Attendance
  'attendance.open': { description: 'Open and close attendance, show the QR', protected: false },
  'attendance.force_close': { description: 'Force-close an attendance session', protected: false },
  'checkins.create': { description: 'Check in to a class', protected: false },
  'attendance.roster_read': { description: 'View the live roster', protected: false },
  'attendance.review_pending': { description: 'Approve or reject pending check-ins', protected: false },
  'attendance.assisted_checkin': { description: 'Lecturer-assisted check-in', protected: false },
  'attendance.correct': { description: 'Correct an attendance record with a reason', protected: false },
  'attendance.read_own': { description: 'View own attendance and history', protected: false },
  'requests.submit': { description: 'Submit a dispute or excuse request', protected: false },
  'requests.review': { description: 'Review disputes and excuse requests', protected: false },

  // Communication
  'announcements.send_official': { description: 'Send official course announcements', protected: false },
  'announcements.send_rep': { description: 'Send course-rep updates', protected: false },
  'announcements.send_institution': { description: 'Send institution-wide announcements', protected: false },
  'announcements.moderate': {
    description: 'Hide announcements and handle message reports',
    protected: false,
  },
  'messages.report': { description: 'Report an abusive message', protected: false },
  'announcement_stats.read': { description: 'View announcement delivery statistics', protected: false },

  // Reports
  'reports.course': { description: 'Course and class attendance reports', protected: false },
  'analytics.read': {
    description: 'Faculty, department, programme and lecturer analytics',
    protected: false,
  },
  'reports.registrar': { description: 'Student record and enrolment reports', protected: false },
  'reports.export_personal': { description: 'Export files containing personal data', protected: false },
} as const satisfies Record<string, { description: string; protected: boolean }>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const PROTECTED_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS.filter(
  (key) => PERMISSIONS[key].protected,
);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/**
 * Permissions that change attendance records or official class status. Students and course reps
 * must never hold any of these (see "What a Course Representative can never do").
 */
export const ATTENDANCE_AND_CLASS_CONTROL_PERMISSIONS: readonly PermissionKey[] = [
  'attendance.open',
  'attendance.force_close',
  'attendance.review_pending',
  'attendance.assisted_checkin',
  'attendance.correct',
  'class_sessions.start',
  'class_sessions.delay',
  'class_sessions.cancel',
  'class_sessions.void',
  'class_sessions.reschedule',
  'class_sessions.suspend',
  'class_reviews.decide',
  'timetables.manage',
  'timetables.publish',
  'requests.review',
];

/**
 * Default grants. COURSE_REP lists only what the rep assignment adds: a course rep is always a student
 * and also holds every STUDENT permission.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  SUPER_ADMIN: [
    'users.manage_admins',
    'roles.assign',
    'roles.edit_permissions',
    'settings.manage',
    'accounts.suspend',
    'verification_policies.manage',
    'monitoring_thresholds.manage',
    'system_health.read',
    'audit_logs.read',
    'risk_flags.review',
    'academic_structure.manage',
    'academic_structure.read',
    'academic_periods.manage',
    'courses.manage',
    'lecturers.manage',
    'lecturer_assignments.manage',
    'course_reps.assign',
    'students.create',
    'students.import',
    'students.update',
    'students.read_full',
    'enrollments.manage',
    'class_lists.read',
    'devices.approve',
    'classrooms.manage',
    'beacons.manage',
    'beacon_health.read',
    'timetables.manage',
    'timetables.publish',
    'timetables.read',
    'class_sessions.cancel',
    'class_sessions.void',
    'class_sessions.reschedule',
    'class_sessions.suspend',
    'class_reviews.decide',
    'attendance.roster_read',
    'attendance.correct',
    'requests.review',
    'announcements.send_institution',
    'announcements.moderate',
    'messages.report',
    'announcement_stats.read',
    'reports.course',
    'analytics.read',
    'reports.registrar',
    'reports.export_personal',
  ],
  UNIVERSITY_ADMIN: [
    'audit_logs.read',
    'risk_flags.review',
    'academic_structure.read',
    'courses.manage',
    'lecturer_assignments.manage',
    'course_reps.assign',
    'class_lists.read',
    'classrooms.manage',
    'beacon_health.read',
    'timetables.manage',
    'timetables.publish',
    'timetables.read',
    'class_sessions.delay',
    'class_sessions.cancel',
    'class_sessions.void',
    'class_sessions.reschedule',
    'class_sessions.suspend',
    'class_reviews.decide',
    'attendance.force_close',
    'attendance.roster_read',
    'attendance.review_pending',
    'attendance.correct',
    'requests.review',
    'announcements.send_official',
    'announcements.send_institution',
    'announcements.moderate',
    'messages.report',
    'announcement_stats.read',
    'reports.course',
    'analytics.read',
    'reports.export_personal',
  ],
  REGISTRAR: [
    'academic_structure.read',
    'students.create',
    'students.import',
    'students.update',
    'students.read_full',
    'enrollments.manage',
    'class_lists.read',
    'timetables.read',
    'messages.report',
    'reports.registrar',
    'reports.export_personal',
  ],
  LECTURER: [
    'risk_flags.read',
    'course_reps.nominate',
    'class_lists.read',
    'beacon_health.read',
    'timetables.read',
    'class_sessions.start',
    'class_sessions.delay',
    'class_sessions.cancel',
    'class_sessions.request_void',
    'class_sessions.request_reschedule',
    'class_issues.report',
    'makeup.suggest',
    'attendance.open',
    'attendance.roster_read',
    'attendance.review_pending',
    'attendance.assisted_checkin',
    'attendance.correct',
    'requests.review',
    'announcements.send_official',
    'announcements.moderate',
    'messages.report',
    'announcement_stats.read',
    'reports.course',
    'reports.export_personal',
  ],
  STUDENT: [
    'timetables.read',
    'class_issues.report',
    'checkins.create',
    'attendance.read_own',
    'requests.submit',
    'devices.request_replacement',
    'messages.report',
  ],
  COURSE_REP: ['makeup.suggest', 'announcements.send_rep', 'announcement_stats.read'],
};

/** Grants the Super Admin may switch on per role ("C" cells in the matrix). Off by default. */
export const CONFIGURABLE_ROLE_PERMISSIONS: Partial<Record<RoleKey, readonly PermissionKey[]>> = {
  UNIVERSITY_ADMIN: [
    'accounts.suspend',
    'verification_policies.manage',
    'monitoring_thresholds.manage',
    'system_health.read',
    'academic_structure.manage',
    'academic_periods.manage',
    'lecturers.manage',
    'devices.approve',
    'beacons.manage',
  ],
  REGISTRAR: ['devices.approve'],
};

/** Effective default permissions for a set of held roles. A course rep also gets STUDENT permissions. */
export function defaultPermissionsFor(roles: readonly RoleKey[]): Set<PermissionKey> {
  const effective = new Set<PermissionKey>();
  const expanded = new Set<RoleKey>(roles);
  if (expanded.has('COURSE_REP')) expanded.add('STUDENT');
  for (const role of expanded) {
    for (const key of DEFAULT_ROLE_PERMISSIONS[role]) effective.add(key);
  }
  return effective;
}
