import { describe, expect, it } from 'vitest';
import { blockingClashes, type ExpandedEntry, overlappingPairs, studentClashes } from './conflicts.js';
import {
  meetingDates,
  type RecurrenceRule,
  ruleDates,
  teachingWeek,
  weekdayOf,
  weeksInSemester,
} from './recurrence.js';

// A made-up semester: Thursday 15 August to Friday 20 December 2030 (weekdays checked with Node).
const START = '2030-08-15';
const END = '2030-12-20';
const tuesday = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  recurrence: 'WEEKLY',
  dayOfWeek: 2,
  effectiveFrom: START,
  effectiveTo: '2030-09-10',
  selectedWeeks: [],
  ...overrides,
});

describe('teaching weeks', () => {
  it('counts the week containing the first day as week 1, Monday to Sunday', () => {
    expect(weekdayOf('2030-08-15')).toBe(4);
    expect(teachingWeek('2030-08-18', START)).toBe(1); // Sunday of the first week
    expect(teachingWeek('2030-08-19', START)).toBe(2); // the next Monday
    expect(weeksInSemester(START, END)).toBe(19);
  });
});

describe('recurrence', () => {
  it('weekly: every matching weekday between the dates', () => {
    expect(ruleDates(tuesday(), START)).toEqual(['2030-08-20', '2030-08-27', '2030-09-03', '2030-09-10']);
  });

  it('every other week: counted from the first meeting, which is never skipped', () => {
    expect(ruleDates(tuesday({ recurrence: 'EVERY_OTHER_WEEK' }), START)).toEqual([
      '2030-08-20',
      '2030-09-03',
    ]);
  });

  it('selected weeks: only the listed teaching weeks', () => {
    const rule = tuesday({ recurrence: 'SELECTED_WEEKS', selectedWeeks: [2, 4, 30], effectiveTo: END });
    expect(ruleDates(rule, START)).toEqual(['2030-08-20', '2030-09-03']);
  });

  it('once: exactly the one date', () => {
    const rule = tuesday({ recurrence: 'ONCE', effectiveFrom: '2030-10-01', effectiveTo: '2030-10-01' });
    expect(ruleDates(rule, START)).toEqual(['2030-10-01']);
  });

  it('respects the effective dates', () => {
    expect(ruleDates(tuesday({ effectiveFrom: '2030-08-28', effectiveTo: '2030-09-03' }), START)).toEqual([
      '2030-09-03',
    ]);
  });

  it('removes holidays and the entry’s own exceptions, and says why', () => {
    const result = meetingDates(
      tuesday(),
      START,
      new Map([['2030-09-03', 'Test Holiday']]),
      new Map([['2030-08-27', 'Lecturer at a conference (test)']]),
    );
    expect(result.dates).toEqual(['2030-08-20', '2030-09-10']);
    expect(result.skipped).toEqual([
      { date: '2030-08-27', why: 'Lecturer at a conference (test)' },
      { date: '2030-09-03', why: 'Test Holiday' },
    ]);
  });
});

describe('clash detection', () => {
  const entry = (id: string, overrides: Partial<ExpandedEntry>): ExpandedEntry => ({
    id,
    classroomId: 'room-1',
    lecturerId: 'lecturer-1',
    sectionIds: [`section-${id}`],
    startMinute: 600,
    endMinute: 690,
    dates: ['2030-08-20'],
    ...overrides,
  });

  it('finds a shared room, lecturer or section at overlapping times on the same date', () => {
    const a = entry('a', { dates: ['2030-08-20', '2030-08-27'] });
    const b = entry('b', {
      lecturerId: 'lecturer-2',
      startMinute: 660,
      endMinute: 720,
      dates: ['2030-08-27'],
    });
    const c = entry('c', {
      classroomId: 'room-2',
      sectionIds: ['section-a'],
      startMinute: 630,
      endMinute: 660,
    });
    const clashes = blockingClashes([a, b, c], overlappingPairs([a, b, c]));
    expect(clashes).toEqual([
      { kind: 'LECTURER_CLASH', entryIds: ['a', 'c'], firstDate: '2030-08-20', dates: 1 },
      { kind: 'SECTION_CLASH', entryIds: ['a', 'c'], firstDate: '2030-08-20', dates: 1 },
      { kind: 'ROOM_CLASH', entryIds: ['a', 'b'], firstDate: '2030-08-27', dates: 1 },
    ]);
  });

  it('allows back-to-back classes and different dates', () => {
    const a = entry('a', {});
    const backToBack = entry('b', { startMinute: 690, endMinute: 780 });
    const otherDay = entry('c', { dates: ['2030-08-21'] });
    expect(overlappingPairs([a, backToBack, otherDay])).toEqual([]);
  });

  it('warns about students enrolled in two overlapping sections', () => {
    const a = entry('a', {});
    const b = entry('b', {
      classroomId: 'room-2',
      lecturerId: 'lecturer-2',
      startMinute: 660,
      endMinute: 720,
    });
    const enrolled = new Map([
      ['section-a', ['student-1', 'student-2']],
      ['section-b', ['student-2', 'student-3']],
    ]);
    const pairs = overlappingPairs([a, b]);
    expect(blockingClashes([a, b], pairs)).toEqual([]);
    expect(studentClashes([a, b], pairs, enrolled)).toEqual([
      { entryIds: ['a', 'b'], firstDate: '2030-08-20', dates: 1, studentIds: ['student-2'] },
    ]);
  });
});
