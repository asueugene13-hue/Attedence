import {
  type BleResult,
  type GpsResult,
  type IntegrityResult,
  type Outcome,
  type RiskType,
  NO_CLASSROOM_SIGNAL_WAITING_MESSAGE,
  STUDENT_MESSAGES,
  type VerificationReason,
  type VerificationRules,
} from '@attendsure/shared';

/**
 * The decision engine (PRESENCE_VERIFICATION.md §6). A pure function: hard gates, then the decision
 * table, then the modifiers. Every step it takes is written to the trace, so any outcome can be
 * explained to a student or in a dispute. It never punishes on its own: doubtful cases go to the
 * lecturer (PENDING_VERIFICATION) or to review (MANUAL_REVIEW_REQUIRED), and flags go to a person.
 */
export interface DecisionInput {
  /** Hard gates, checked by the caller from the database and the QR token (Phase 5). */
  qr: 'VALID' | 'INVALID' | 'EXPIRED';
  sessionOpen: boolean;
  enrolled: boolean;
  accountActive: boolean;
  device: 'TRUSTED' | 'PENDING_APPROVAL' | 'REVOKED' | 'REPLACED';
  /** Attempts already made by this student in this attendance session. */
  attemptsSoFar: number;
  /** Rejections "with retry" this student already had in this session. */
  retryRejectionsSoFar: number;
  ble: BleResult;
  gps: GpsResult;
  integrity: IntegrityResult;
  /** Another student checked in from this same phone in this session. */
  sharedDeviceInSession: boolean;
  /** The room's beacon is suspected faulty: missing beacon evidence is not held against students. */
  degradedMode: boolean;
}

export interface Decision {
  outcome: Outcome;
  reason: VerificationReason | null;
  message: string;
  /** The student may try again (and, after a second such rejection, ask the lecturer to review). */
  retryAllowed: boolean;
  canAskForReview: boolean;
  /** Risk flags to raise for a person to review. */
  flags: RiskType[];
  /** Every rule the engine applied, in order. */
  trace: string[];
}

export function decide(input: DecisionInput, rules: VerificationRules): Decision {
  const trace: string[] = [];
  const flags = new Set<RiskType>();

  // ── Step 1: hard gates. Any failure is a plain rejection with its reason. ──
  const gates: [boolean, VerificationReason, string][] = [
    [input.qr === 'INVALID', 'QR_INVALID', 'QR token malformed or signature wrong'],
    [input.qr === 'EXPIRED', 'QR_EXPIRED', 'QR token window too old'],
    [!input.sessionOpen, 'SESSION_NOT_OPEN', 'attendance session not open'],
    [!input.enrolled, 'NOT_ENROLLED', 'student not enrolled in the session’s sections'],
    [!input.accountActive, 'ACCOUNT_INACTIVE', 'account or student status not active'],
    [input.device === 'REVOKED' || input.device === 'REPLACED', 'DEVICE_REVOKED', `device ${input.device}`],
    [
      input.attemptsSoFar >= rules.maxAttemptsPerSession,
      'TOO_MANY_ATTEMPTS',
      `${input.attemptsSoFar} attempts, limit ${rules.maxAttemptsPerSession}`,
    ],
  ];
  for (const [failed, reason, why] of gates) {
    if (failed) {
      trace.push(`gate ${reason}: ${why}`);
      return { ...result('REJECTED', reason, false), flags: [], trace };
    }
  }
  trace.push('all gates passed');
  trace.push(
    `evidence: BLE ${input.ble}, GPS ${input.gps}, device ${input.device}, integrity ${input.integrity}`,
  );

  // ── Step 2/3: the decision table. ──
  let decision = table();

  // ── Modifiers. ──
  if (input.integrity === 'FAIL') {
    flags.add('INTEGRITY_FAILED');
    if (decision.outcome === 'VERIFIED') {
      trace.push(`modifier: integrity failed → ${rules.integrityFailAction}`);
      decision = result(rules.integrityFailAction, 'INTEGRITY_FAILED', false);
    } else {
      trace.push('modifier: integrity failed (flag only; outcome already not verified)');
    }
  }
  if (input.sharedDeviceInSession && decision.outcome !== 'REJECTED') {
    flags.add('SHARED_DEVICE');
    trace.push('modifier: phone shared with another student in this session → MANUAL_REVIEW_REQUIRED');
    decision = result('MANUAL_REVIEW_REQUIRED', 'SHARED_DEVICE', false);
  }
  return { ...decision, flags: [...flags], trace };

  function table(): Omit<Decision, 'flags' | 'trace'> {
    const trusted = input.device === 'TRUSTED';
    const ble = !rules.bleRequired && (input.ble === 'OFF' || input.ble === 'NONE') ? 'NONE' : input.ble;
    if (!rules.bleRequired) trace.push('policy: beacon not required');

    if (input.gps === 'MOCKED') {
      flags.add('MOCK_LOCATION');
      trace.push(`row: location from a mock-location app → ${rules.mockLocationAction}`);
      return result(rules.mockLocationAction, 'MOCK_LOCATION', false);
    }
    if (ble === 'OFF') {
      trace.push('row: Bluetooth off → rejected, retry allowed');
      return result('REJECTED', 'BLUETOOTH_OFF', true);
    }
    if ((ble === 'STRONG' || ble === 'WEAK') && input.gps === 'OUTSIDE') {
      flags.add('BEACON_LOCATION_CONFLICT');
      trace.push('row: classroom beacon heard but GPS clearly off site → MANUAL_REVIEW_REQUIRED');
      return result('MANUAL_REVIEW_REQUIRED', 'LOCATION_CONFLICT', false);
    }
    if (ble === 'OTHER_ROOM') {
      trace.push('row: only other rooms’ beacons heard strongly → rejected, retry allowed');
      return result('REJECTED', 'WRONG_ROOM', true);
    }
    if (ble === 'NONE' && input.degradedMode && rules.bleRequired) {
      if (input.gps === 'OUTSIDE') {
        trace.push('row: degraded mode, but GPS clearly off site → rejected');
        return result('REJECTED', 'NOT_IN_CLASSROOM', false);
      }
      if (trusted) {
        trace.push('row: degraded mode (beacon suspected faulty), GPS not off site → PENDING_VERIFICATION');
        return result('PENDING_VERIFICATION', 'DEGRADED_MODE', false);
      }
    }
    if (!trusted) {
      // A phone waiting for approval (not revoked: that failed the gates).
      if (input.gps === 'OUTSIDE') {
        trace.push('row: new phone and GPS clearly off site → rejected');
        return result('REJECTED', 'NOT_IN_CLASSROOM', false);
      }
      if (ble === 'STRONG' || ble === 'WEAK' || input.gps === 'INSIDE') {
        flags.add('DEVICE_SWITCH');
        trace.push(`row: classroom evidence from a phone not yet approved → ${rules.newDeviceAction}`);
        return result(rules.newDeviceAction, 'NEW_DEVICE', false);
      }
      trace.push('row: no classroom evidence from a phone not yet approved → rejected, retry allowed');
      return result('REJECTED', 'NO_CLASSROOM_SIGNAL', true);
    }
    if (ble === 'STRONG') {
      trace.push('row: strong classroom beacon, GPS not off site, trusted phone → VERIFIED');
      return result('VERIFIED', null, false);
    }
    if (ble === 'WEAK') {
      trace.push(`row: weak classroom beacon, trusted phone → ${rules.bleWeakAction}`);
      return rules.bleWeakAction === 'VERIFIED'
        ? result('VERIFIED', null, false)
        : result(rules.bleWeakAction, 'WEAK_SIGNAL', false);
    }
    // No beacon heard (or beacons not required).
    if (input.gps === 'INSIDE') {
      trace.push(`row: no beacon, GPS inside, trusted phone → ${rules.noBleGpsInsideAction}`);
      return result(rules.noBleGpsInsideAction, 'NO_CLASSROOM_SIGNAL', false);
    }
    if (input.gps === 'OUTSIDE') {
      trace.push('row: no beacon and GPS clearly off site → rejected');
      return result('REJECTED', 'NOT_IN_CLASSROOM', false);
    }
    trace.push('row: no beacon and GPS uncertain → rejected, retry allowed');
    return result('REJECTED', 'NO_CLASSROOM_SIGNAL', true);
  }

  function result(outcome: Outcome, reason: VerificationReason | null, retryAllowed: boolean) {
    const canAskForReview = retryAllowed && input.retryRejectionsSoFar >= 1;
    if (canAskForReview)
      trace.push('second rejection with retry: the student may ask the lecturer to review');
    return {
      outcome,
      reason,
      message:
        reason === 'NO_CLASSROOM_SIGNAL' && outcome !== 'REJECTED'
          ? NO_CLASSROOM_SIGNAL_WAITING_MESSAGE
          : STUDENT_MESSAGES[reason ?? 'VERIFIED'],
      retryAllowed,
      canAskForReview,
    };
  }
}
