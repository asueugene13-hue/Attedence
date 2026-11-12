import { describe, expect, it } from 'vitest';
import { type ClassFact, judgeClass, summarise, warning } from './calculation.js';

let n = 0;
const cls = (over: Partial<ClassFact> = {}): ClassFact => ({
  classSessionId: `class-${++n}`,
  scheduledStart: new Date('2030-08-20T10:00:00Z'),
  classStatus: 'COMPLETED',
  attendance: { closed: true, voided: false },
  eligible: true,
  record: 'PRESENT',
  ...over,
});

describe('which classes count (ATTENDANCE_FLOW §9)', () => {
  it('scenario 21: a cancelled class never counts as an absence', () => {
    expect(judgeClass(cls({ classStatus: 'CANCELLED', attendance: null, record: null }))).toMatchObject({
      counted: false,
      notCounted: 'CANCELLED',
    });
    for (const classStatus of ['RESCHEDULED', 'SUSPENDED']) {
      expect(judgeClass(cls({ classStatus, record: null })).notCounted).toBe('CANCELLED');
    }
    // A class voided after attendance started is not counted either.
    expect(
      judgeClass(
        cls({ classStatus: 'CANCELLED', attendance: { closed: true, voided: true }, record: 'VOIDED' }),
      ).notCounted,
    ).toBe('VOIDED');
  });

  it('only held classes with attendance taken and closed, for students enrolled at the time', () => {
    expect(judgeClass(cls({ eligible: false })).notCounted).toBe('NOT_ENROLLED_YET');
    expect(judgeClass(cls({ classStatus: 'UNDER_REVIEW' })).notCounted).toBe('UNDER_REVIEW');
    expect(judgeClass(cls({ classStatus: 'SCHEDULED', record: null })).notCounted).toBe('NOT_HELD_YET');
    expect(judgeClass(cls({ classStatus: 'ACTIVE' })).notCounted).toBe('NOT_HELD_YET');
    expect(judgeClass(cls({ attendance: null, record: null })).notCounted).toBe('NO_ATTENDANCE_TAKEN');
    expect(judgeClass(cls({ attendance: { closed: false, voided: false } })).notCounted).toBe(
      'ATTENDANCE_OPEN',
    );
    expect(judgeClass(cls({ record: null })).notCounted).toBe('NO_RECORD'); // never a made-up absence
  });

  it('maps records to outcomes: rejected is an absence, waiting is undecided', () => {
    const outcome = (record: ClassFact['record']) => judgeClass(cls({ record })).outcome;
    expect(outcome('PRESENT')).toBe('PRESENT');
    expect(outcome('LATE')).toBe('LATE');
    expect(outcome('ABSENT')).toBe('ABSENT');
    expect(outcome('REJECTED')).toBe('ABSENT');
    expect(outcome('EXCUSED')).toBe('EXCUSED');
    expect(outcome('PENDING')).toBe('UNDECIDED');
    expect(outcome('UNDER_REVIEW')).toBe('UNDECIDED');
  });
});

describe('the percentage', () => {
  const results = [
    ...Array.from({ length: 6 }, () => judgeClass(cls({ record: 'PRESENT' }))),
    ...Array.from({ length: 2 }, () => judgeClass(cls({ record: 'LATE' }))),
    judgeClass(cls({ record: 'ABSENT' })),
    judgeClass(cls({ record: 'REJECTED' })),
    judgeClass(cls({ record: 'EXCUSED' })),
    judgeClass(cls({ record: 'PENDING' })),
    judgeClass(cls({ classStatus: 'CANCELLED', attendance: null, record: null })),
    judgeClass(cls({ eligible: false })),
  ];

  it('is (present + w × late) ÷ (eligible − excused − undecided), to one decimal', () => {
    // Eligible 12; denominator 12 − 1 − 1 = 10; late counts fully by default: (6 + 2) / 10.
    expect(summarise(results, 1)).toEqual({
      eligible: 12,
      present: 6,
      late: 2,
      absences: 2,
      excused: 1,
      undecided: 1,
      cancelled: 1,
      percentage: 80,
    });
    // With late counting half: (6 + 1) / 10.
    expect(summarise(results, 0.5).percentage).toBe(70);
    expect(
      summarise(
        [
          judgeClass(cls({ record: 'PRESENT' })),
          judgeClass(cls({ record: 'PRESENT' })),
          judgeClass(cls({ record: 'ABSENT' })),
        ],
        1,
      ).percentage,
    ).toBe(66.7);
  });

  it('is null until a class counts', () => {
    expect(summarise([], 1).percentage).toBeNull();
    expect(summarise([judgeClass(cls({ record: 'EXCUSED' }))], 1).percentage).toBeNull();
  });

  it('warns only once a minimum is set, with how many more absences are possible', () => {
    const summary = summarise(results, 1); // 8 of 10
    expect(warning(summary, 1, null, 5)).toBeNull();
    // Minimum 75%: 8 + 5 − n over 15 ≥ 0.75 → n ≤ 1.75, so 1 more absence.
    expect(warning(summary, 1, 75, 5)).toEqual({
      minimumPercent: 75,
      belowMinimum: false,
      absencesAllowed: 1,
      remainingClasses: 5,
    });
    expect(warning(summary, 1, 85, 5)).toMatchObject({ belowMinimum: true, absencesAllowed: 0 });
    expect(warning(summary, 1, 80, 0)).toMatchObject({ belowMinimum: false, absencesAllowed: 0 });
  });
});
