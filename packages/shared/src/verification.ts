import { z } from 'zod';
import { ReasonSchema } from './admin.js';

/**
 * Classroom verification (PRESENCE_VERIFICATION.md §4–§9). The server decides; the phone only collects
 * evidence. These names are shared so the apps can show the same words the server uses.
 */
export const OUTCOMES = ['VERIFIED', 'PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED', 'REJECTED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const BLE_RESULTS = ['STRONG', 'WEAK', 'OTHER_ROOM', 'NONE', 'OFF'] as const;
export type BleResult = (typeof BLE_RESULTS)[number];

export const GPS_RESULTS = ['INSIDE', 'OUTSIDE', 'UNCERTAIN', 'MOCKED'] as const;
export type GpsResult = (typeof GPS_RESULTS)[number];

/** NOT_AVAILABLE: the check is not set up yet (no Play Console / Apple account). It never counts against anyone. */
export const INTEGRITY_RESULTS = ['PASS', 'FAIL', 'NOT_AVAILABLE'] as const;
export type IntegrityResult = (typeof INTEGRITY_RESULTS)[number];

/** Why a check-in was rejected or held, as a code the apps can explain. */
export const VERIFICATION_REASONS = [
  'QR_INVALID',
  'QR_EXPIRED',
  'SESSION_NOT_OPEN',
  'NOT_ENROLLED',
  'ACCOUNT_INACTIVE',
  'DEVICE_REVOKED',
  'TOO_MANY_ATTEMPTS',
  'BLUETOOTH_OFF',
  'WRONG_ROOM',
  'NO_CLASSROOM_SIGNAL',
  'NOT_IN_CLASSROOM',
  'WEAK_SIGNAL',
  'NEW_DEVICE',
  'LOCATION_CONFLICT',
  'MOCK_LOCATION',
  'INTEGRITY_FAILED',
  'SHARED_DEVICE',
  'DEGRADED_MODE',
  'DELAYED_UPLOAD',
] as const;
export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/** What the student is told for each outcome (§6), in plain words. */
export const STUDENT_MESSAGES: Record<VerificationReason | 'VERIFIED', string> = {
  VERIFIED: 'You’re checked in.',
  QR_INVALID: 'That code is not a valid AttendSure code. Scan the code on the lecturer’s screen.',
  QR_EXPIRED: 'That code has expired. Scan the code currently on the lecturer’s screen.',
  SESSION_NOT_OPEN: 'Attendance is not open for this class.',
  NOT_ENROLLED: 'You are not enrolled in this class.',
  ACCOUNT_INACTIVE: 'Your account is not active. Contact the Registrar.',
  DEVICE_REVOKED: 'This phone can no longer be used for attendance. Ask the Registrar for help.',
  TOO_MANY_ATTEMPTS: 'Too many attempts for this class. Ask your lecturer to check you in.',
  BLUETOOTH_OFF: 'Bluetooth is needed to check in. Turn it on and try again.',
  WRONG_ROOM: 'You seem to be in another room. Move into the classroom and try again.',
  NO_CLASSROOM_SIGNAL: 'We couldn’t detect the classroom. Move closer to the front and try again.',
  NOT_IN_CLASSROOM: 'You don’t appear to be in the classroom.',
  WEAK_SIGNAL: 'Waiting for your lecturer to confirm.',
  NEW_DEVICE: 'Waiting for your lecturer to confirm. This phone is not your approved attendance phone yet.',
  LOCATION_CONFLICT: 'Your check-in needs review.',
  MOCK_LOCATION: 'Your check-in needs review.',
  INTEGRITY_FAILED: 'Waiting for your lecturer to confirm.',
  SHARED_DEVICE: 'Your check-in needs review.',
  DEGRADED_MODE: 'Waiting for your lecturer to confirm.',
  DELAYED_UPLOAD:
    'Your check-in arrived late because of the connection. Waiting for your lecturer to confirm.',
};

/**
 * "No classroom signal" when it waits for the lecturer instead of being rejected (on site, no beacon
 * heard): nothing to retry, so the rejection's "try again" would mislead.
 */
export const NO_CLASSROOM_SIGNAL_WAITING_MESSAGE =
  'We couldn’t detect the classroom, so your lecturer will confirm your check-in.';

/** After a second rejection that allows a retry, the student may ask the lecturer to review instead. */
export const ASK_FOR_REVIEW_MESSAGE = 'Still not working? Ask your lecturer to review your check-in.';

const outcomeOf = <T extends Outcome>(...allowed: readonly T[]) => z.enum(allowed as [T, ...T[]]);

/** The policy's rules with their defaults (§9). Every value is checked; versions are never edited. */
export const VerificationRulesSchema = z.strictObject({
  qrRotationSeconds: z.number().int().min(10).max(30).default(15),
  qrGraceWindows: z.number().int().min(0).max(2).default(1),
  bleScanSeconds: z.number().int().min(3).max(15).default(6),
  /** Turning this off needs a Super Admin and is audited. */
  bleRequired: z.boolean().default(true),
  bleWeakAction: outcomeOf('VERIFIED', 'PENDING_VERIFICATION').default('PENDING_VERIFICATION'),
  noBleGpsInsideAction: outcomeOf('PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED').default(
    'PENDING_VERIFICATION',
  ),
  gpsMaxUsableAccuracyM: z.number().int().min(20).max(500).default(150),
  gpsOutsideMarginM: z.number().int().min(0).max(500).default(50),
  requireTrustedDevice: z.boolean().default(true),
  newDeviceAction: outcomeOf('PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED').default(
    'PENDING_VERIFICATION',
  ),
  integrityFailAction: outcomeOf('PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED').default(
    'PENDING_VERIFICATION',
  ),
  mockLocationAction: outcomeOf('MANUAL_REVIEW_REQUIRED', 'REJECTED').default('MANUAL_REVIEW_REQUIRED'),
  maxAttemptsPerSession: z.number().int().min(1).max(20).default(5),
  offlineGraceSeconds: z.number().int().min(0).max(600).default(120),
  /**
   * Beacon health (§3): during a class, this many different phones on site with Bluetooth on, within
   * the window below, all hearing none of the room's beacons, mark them suspected faulty.
   */
  beaconFaultMinDevices: z.number().int().min(2).max(20).default(3),
  beaconFaultWindowMinutes: z.number().int().min(5).max(30).default(10),
  /** The same beacon heard this far apart within 5 minutes is flagged (a copied beacon?). */
  beaconConflictDistanceM: z.number().int().min(200).max(20_000).default(1000),
});
export type VerificationRules = z.output<typeof VerificationRulesSchema>;

/** The defaults, used until the first saved version. */
export const DEFAULT_VERIFICATION_RULES: VerificationRules = VerificationRulesSchema.parse({});

/** A new version: every rule (missing ones take their defaults) and why it changed. */
export const NewPolicyVersionSchema = z.strictObject({
  rules: VerificationRulesSchema,
  reason: ReasonSchema,
});

/** "What would the engine decide?" — evidence entered by hand, for administrators trying the policy. */
export const TryDecisionSchema = z.strictObject({
  ble: z.enum(BLE_RESULTS),
  gps: z.enum(GPS_RESULTS),
  device: z.enum(['TRUSTED', 'PENDING_APPROVAL']).default('TRUSTED'),
  integrity: z.enum(INTEGRITY_RESULTS).default('NOT_AVAILABLE'),
  sharedDeviceInSession: z.boolean().default(false),
  degradedMode: z.boolean().default(false),
  retryRejectionsSoFar: z.number().int().min(0).max(20).default(0),
});

/**
 * "Check this classroom" from the phone (Phase 4 step 4): what the phone heard and one location
 * reading. The server runs the real rules and returns the decision; nothing is recorded.
 */
export const ClassroomCheckSchema = z.strictObject({
  classroomId: z.uuid(),
  /** OFF: Bluetooth switched off; DENIED: the permission was refused. */
  bluetooth: z.enum(['ON', 'OFF', 'DENIED']),
  readings: z
    .array(
      z.strictObject({
        /** As broadcast: Eddystone-UID namespace+instance in hex, or iBeacon uuid:major:minor. */
        identifier: z
          .string()
          .trim()
          .min(3)
          .max(80)
          .transform((v) => v.toLowerCase()),
        rssi: z.number().int().min(-120).max(0),
      }),
    )
    .max(200),
  location: z
    .strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyM: z.number().min(0).max(100_000),
      isMocked: z.boolean().optional(),
    })
    .nullable(),
});
