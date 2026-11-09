import { describe, expect, it } from 'vitest';
import { dayIn, wallClockToUtc } from './time-zone.js';

describe('wall-clock time to an exact instant', () => {
  it('Africa/Accra is UTC all year (no daylight saving)', () => {
    expect(wallClockToUtc('2030-08-20', 600, 'Africa/Accra').toISOString()).toBe('2030-08-20T10:00:00.000Z');
    expect(wallClockToUtc('2030-01-14', 0, 'Africa/Accra').toISOString()).toBe('2030-01-14T00:00:00.000Z');
  });

  it('handles zones with daylight saving on both sides of the change', () => {
    // London: GMT in winter, BST (UTC+1) in summer. The 2030 change is on Sunday 31 March.
    expect(wallClockToUtc('2030-03-29', 600, 'Europe/London').toISOString()).toBe('2030-03-29T10:00:00.000Z');
    expect(wallClockToUtc('2030-04-02', 600, 'Europe/London').toISOString()).toBe('2030-04-02T09:00:00.000Z');
  });

  it('tells which local day an instant falls on', () => {
    expect(dayIn(new Date('2030-08-20T23:30:00Z'), 'Africa/Accra')).toBe('2030-08-20');
    expect(dayIn(new Date('2030-08-20T23:30:00Z'), 'Europe/London')).toBe('2030-08-21');
  });
});
