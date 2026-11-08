import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_AND_CLASS_CONTROL_PERMISSIONS,
  CONFIGURABLE_ROLE_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_KEYS,
  PROTECTED_PERMISSIONS,
  defaultPermissionsFor,
  isPermissionKey,
} from './permissions.js';
import { ROLE_KEYS, isRoleKey, type RoleKey } from './roles.js';

describe('permission catalogue', () => {
  it('uses domain.action keys', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('marks exactly the four Super Admin powers as protected', () => {
    expect([...PROTECTED_PERMISSIONS].sort()).toEqual(
      ['roles.assign', 'roles.edit_permissions', 'settings.manage', 'users.manage_admins'].sort(),
    );
  });

  it('recognises valid and invalid keys', () => {
    expect(isPermissionKey('attendance.correct')).toBe(true);
    expect(isPermissionKey('attendance.delete_everything')).toBe(false);
    expect(isPermissionKey('toString')).toBe(false);
  });
});

describe('default role grants', () => {
  it('defines grants for every role, without duplicates', () => {
    for (const role of ROLE_KEYS) {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      expect(new Set(grants).size).toBe(grants.length);
    }
  });

  it('gives protected permissions only to SUPER_ADMIN, by default and configurably', () => {
    const others = ROLE_KEYS.filter((r) => r !== 'SUPER_ADMIN');
    for (const role of others) {
      const possible = [...DEFAULT_ROLE_PERMISSIONS[role], ...(CONFIGURABLE_ROLE_PERMISSIONS[role] ?? [])];
      for (const key of PROTECTED_PERMISSIONS) {
        expect(possible).not.toContain(key);
      }
    }
  });

  it('never lets students or course reps change attendance or class status', () => {
    const studentSide = defaultPermissionsFor(['STUDENT', 'COURSE_REP']);
    for (const key of ATTENDANCE_AND_CLASS_CONTROL_PERMISSIONS) {
      expect(studentSide.has(key)).toBe(false);
    }
  });

  it('lets only students check in; staff cannot check in for themselves', () => {
    const staff: RoleKey[] = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN', 'REGISTRAR', 'LECTURER'];
    for (const role of staff) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('checkins.create');
    }
    expect(DEFAULT_ROLE_PERMISSIONS.STUDENT).toContain('checkins.create');
  });

  it('does not let the Super Admin start classes or run attendance (people in the room do that)', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).not.toContain('class_sessions.start');
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).not.toContain('attendance.open');
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).not.toContain('attendance.assisted_checkin');
  });

  it('gives a course rep every student permission plus the rep extras', () => {
    const rep = defaultPermissionsFor(['COURSE_REP']);
    for (const key of DEFAULT_ROLE_PERMISSIONS.STUDENT) expect(rep.has(key)).toBe(true);
    expect(rep.has('announcements.send_rep')).toBe(true);
    expect(defaultPermissionsFor(['STUDENT']).has('announcements.send_rep')).toBe(false);
  });

  it('keeps configurable grants separate from defaults', () => {
    for (const [role, keys] of Object.entries(CONFIGURABLE_ROLE_PERMISSIONS)) {
      expect(isRoleKey(role)).toBe(true);
      for (const key of keys ?? []) {
        expect(DEFAULT_ROLE_PERMISSIONS[role as RoleKey]).not.toContain(key);
      }
    }
  });
});
