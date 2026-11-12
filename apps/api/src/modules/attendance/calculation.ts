import type { AttendanceStatus } from '@attendsure/shared';

/**
 * Attendance percentages (ATTENDANCE_FLOW.md §9, interim rules until D-09). Pure functions, so every
 * rule is tested with fixed examples. Nothing here is stored: percentages are worked out from the
 * records each time, so a correction is reflected at once.
 */

export interface ClassFact {
  classSessionId: string;
  scheduledStart: Date;
  /** The class's status (CLASS_LIFECYCLE). */
  classStatus: string;
  /** The class's attendance session, if attendance was ever opened. */
  attendance: { closed: boolean; voided: boolean } | null;
  /** Enrolled in one of the class's sections at its scheduled start. */
  eligible: boolean;
  /** This student's record for the class, if any. */
  record: AttendanceStatus | null;
}

export type NotCountedReason =
  | 'CANCELLED'
  | 'NOT_ENROLLED_YET'
  | 'NOT_HELD_YET'
  | 'UNDER_REVIEW'
  | 'NO_ATTENDANCE_TAKEN'
  | 'ATTENDANCE_OPEN'
  | 'VOIDED'
  | 'NO_RECORD';

export type Outcome = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED' | 'UNDECIDED';

export interface ClassResult {
  classSessionId: string;
  scheduledStart: Date;
  counted: boolean;
  /** Why the class is not counted, when it is not. */
  notCounted: NotCountedReason | null;
  outcome: Outcome | null;
  record: AttendanceStatus | null;
}

/** §9: whether a class counts for a student, and how. */
export function judgeClass(c: ClassFact): ClassResult {
  const result = (notCounted: NotCountedReason | null, outcome: Outcome | null): ClassResult => ({
    classSessionId: c.classSessionId,
    scheduledStart: c.scheduledStart,
    counted: notCounted === null,
    notCounted,
    outcome,
    record: c.record,
  });
  // A cancelled (or voided), rescheduled or suspended class never counts: it is not the student's doing.
  if (['CANCELLED', 'RESCHEDULED', 'SUSPENDED'].includes(c.classStatus)) {
    return result(c.attendance?.voided || c.record === 'VOIDED' ? 'VOIDED' : 'CANCELLED', null);
  }
  if (!c.eligible) return result('NOT_ENROLLED_YET', null);
  if (c.classStatus === 'UNDER_REVIEW') return result('UNDER_REVIEW', null);
  if (c.classStatus !== 'COMPLETED') return result('NOT_HELD_YET', null);
  // Held without attendance being taken: not the student's fault.
  if (!c.attendance) return result('NO_ATTENDANCE_TAKEN', null);
  if (c.attendance.voided || c.record === 'VOIDED') return result('VOIDED', null);
  if (!c.attendance.closed) return result('ATTENDANCE_OPEN', null);
  // Closing marks every eligible student; a missing record is never turned into an absence here.
  if (!c.record) return result('NO_RECORD', null);
  switch (c.record) {
    case 'PRESENT':
      return result(null, 'PRESENT');
    case 'LATE':
      return result(null, 'LATE');
    case 'EXCUSED':
      return result(null, 'EXCUSED');
    case 'PENDING':
    case 'UNDER_REVIEW':
      return result(null, 'UNDECIDED');
    default:
      return result(null, 'ABSENT'); // ABSENT and REJECTED both count as absences
  }
}

export interface Summary {
  /** Classes that count (held, attendance taken and closed, the student eligible). */
  eligible: number;
  present: number;
  late: number;
  /** Absent or rejected. */
  absences: number;
  excused: number;
  /** Waiting for a decision; shown separately and left out until decided. */
  undecided: number;
  /** Cancelled, rescheduled, suspended or voided: shown for information, never counted. */
  cancelled: number;
  /** One decimal place; null when no class counts yet. */
  percentage: number | null;
}

/** §9: (PRESENT + w × LATE) ÷ (eligible − EXCUSED − undecided) × 100, rounded to one decimal. */
export function summarise(results: ClassResult[], lateWeight: number): Summary {
  const counted = results.filter((r) => r.counted);
  const n = (o: Outcome) => counted.filter((r) => r.outcome === o).length;
  const present = n('PRESENT');
  const late = n('LATE');
  const excused = n('EXCUSED');
  const undecided = n('UNDECIDED');
  const denominator = counted.length - excused - undecided;
  return {
    eligible: counted.length,
    present,
    late,
    absences: n('ABSENT'),
    excused,
    undecided,
    cancelled: results.filter((r) => r.notCounted === 'CANCELLED' || r.notCounted === 'VOIDED').length,
    percentage:
      denominator > 0 ? Math.round(((present + lateWeight * late) / denominator) * 1000) / 10 : null,
  };
}

/**
 * The low-attendance warning (§9), only once a minimum has been set. `absencesAllowed` is how many
 * more of the remaining classes the student could miss and still end at or above the minimum,
 * assuming they attend the rest.
 */
export function warning(
  summary: Summary,
  lateWeight: number,
  minimumPercent: number | null,
  remainingClasses: number,
) {
  if (minimumPercent === null || summary.percentage === null) return null;
  const attended = summary.present + lateWeight * summary.late;
  const denominator = summary.eligible - summary.excused - summary.undecided;
  const allowed = Math.floor(
    attended + remainingClasses - (minimumPercent / 100) * (denominator + remainingClasses) + 1e-9,
  );
  return {
    minimumPercent,
    belowMinimum: summary.percentage < minimumPercent,
    absencesAllowed: Math.max(0, Math.min(remainingClasses, allowed)),
    remainingClasses,
  };
}
