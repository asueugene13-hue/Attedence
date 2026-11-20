import { describe, expect, it } from 'vitest';
import { NOTIFICATION_AUDIENCE, NOTIFICATION_CATEGORY_KEYS, categoriesForRoles } from './notifications.js';
import { ROLE_KEYS } from './roles.js';

describe('who receives each kind of notification', () => {
  it('gives every kind at least one role, so none is hidden from everyone', () => {
    const covered = new Set(ROLE_KEYS.flatMap((r) => NOTIFICATION_AUDIENCE[r]));
    expect(NOTIFICATION_CATEGORY_KEYS.filter((c) => !covered.has(c))).toEqual([]);
  });

  it('shows students only messages meant for students', () => {
    const student = categoriesForRoles(['STUDENT']);
    expect(student).toContain('CLASS_CANCELLED');
    expect(student).toContain('EXCUSE_DECIDED');
    expect(student).not.toContain('CORRECTION_REQUESTED');
    expect(student).not.toContain('PHONE_APPROVAL_REQUESTED');
    expect(student).not.toContain('CLASS_PROMPT');
  });

  it('combines every role a person holds, in catalogue order', () => {
    const both = categoriesForRoles(['LECTURER', 'REGISTRAR']);
    expect(both).toContain('DISPUTE_SUBMITTED');
    expect(both).toContain('PHONE_APPROVAL_REQUESTED');
    expect(both).toEqual(NOTIFICATION_CATEGORY_KEYS.filter((c) => both.includes(c)));
    expect(new Set(both).size).toBe(both.length);
  });
});
