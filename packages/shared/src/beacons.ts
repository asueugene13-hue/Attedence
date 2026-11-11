import { z } from 'zod';
import { DateOnlySchema } from './academic.js';
import { ReasonSchema } from './admin.js';

/**
 * Classroom beacons and calibration (PRESENCE_VERIFICATION.md §3). The beacon type is chosen by the
 * classroom trial (D-08); rotating-ID beacons are preferred because a copy made yesterday is useless.
 */
export const BEACON_PROTOCOLS = ['EDDYSTONE_EID', 'VENDOR_ROTATING', 'EDDYSTONE_UID', 'IBEACON'] as const;
export const ROTATING_PROTOCOLS: readonly (typeof BEACON_PROTOCOLS)[number][] = [
  'EDDYSTONE_EID',
  'VENDOR_ROTATING',
];
export const BEACON_STATUSES = ['ACTIVE', 'SUSPECTED_FAULTY', 'INACTIVE'] as const;

/** Where a calibration reading was taken (§3). The INSIDE_ positions count as inside the room. */
export const SURVEY_POSITIONS = [
  'INSIDE_FRONT',
  'INSIDE_MIDDLE',
  'INSIDE_BACK_ROW',
  'INSIDE_CORNER',
  'DOORWAY',
  'CORRIDOR',
  'NEIGHBOUR_ROOM',
  'OUTSIDE_BUILDING',
] as const;
export type SurveyPosition = (typeof SURVEY_POSITIONS)[number];
export const isInsidePosition = (p: SurveyPosition) => p.startsWith('INSIDE_');

/** §3: measured with at least this many phone models before a threshold is set. */
export const MIN_SURVEY_PHONE_MODELS = 3;

const IDENTIFIER_RULES: Record<(typeof BEACON_PROTOCOLS)[number], { pattern: RegExp; example: string }> = {
  // Eddystone-UID: 10-byte namespace + 6-byte instance, in hex.
  EDDYSTONE_UID: { pattern: /^[0-9a-f]{32}$/, example: '32 hex characters (namespace + instance)' },
  // iBeacon: proximity UUID, major and minor.
  IBEACON: {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}:\d{1,5}$/,
    example: 'uuid:major:minor',
  },
  // Rotating protocols: the vendor's serial or registration ID (the broadcast changes).
  EDDYSTONE_EID: { pattern: /^[0-9a-z][0-9a-z._:-]{2,63}$/, example: 'the beacon’s serial' },
  VENDOR_ROTATING: { pattern: /^[0-9a-z][0-9a-z._:-]{2,63}$/, example: 'the beacon’s serial' },
};

const beaconFields = {
  classroomId: z.uuid(),
  label: z.string().trim().min(2).max(100),
  txPowerDbm: z.number().int().min(-40).max(10).optional(),
  installedOn: DateOnlySchema.optional(),
  notes: z.string().trim().max(500).optional(),
};

export const CreateBeaconSchema = z
  .strictObject({
    ...beaconFields,
    protocol: z.enum(BEACON_PROTOCOLS),
    identifier: z
      .string()
      .trim()
      .transform((v) => v.toLowerCase()),
    /** Rotating protocols only: the 16-byte key, in hex. Stored encrypted, never shown again. */
    rotationKey: z
      .string()
      .regex(/^[0-9a-fA-F]{32}$/, 'must be 32 hex characters (16 bytes)')
      .optional(),
    /** Eddystone-EID only: the identifier changes every 2^k seconds (0–15). */
    rotationExponent: z.number().int().min(0).max(15).optional(),
  })
  .superRefine((v, ctx) => {
    const rule = IDENTIFIER_RULES[v.protocol];
    if (!rule.pattern.test(v.identifier)) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: `must be ${rule.example}` });
    }
    const rotating = ROTATING_PROTOCOLS.includes(v.protocol);
    if (rotating && !v.rotationKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['rotationKey'],
        message: 'is required for a rotating-ID beacon',
      });
    }
    if (!rotating && v.rotationKey) {
      ctx.addIssue({ code: 'custom', path: ['rotationKey'], message: 'applies only to rotating-ID beacons' });
    }
    if ((v.protocol === 'EDDYSTONE_EID') !== (v.rotationExponent !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rotationExponent'],
        message: 'is required for Eddystone-EID, and only for it',
      });
    }
  });

export const UpdateBeaconSchema = z.strictObject({
  label: beaconFields.label.optional(),
  classroomId: beaconFields.classroomId.optional(),
  /** SUSPECTED_FAULTY is set by beacon health; people switch beacons on and off. */
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  txPowerDbm: beaconFields.txPowerDbm,
  batteryPercent: z.number().int().min(0).max(100).optional(),
  installedOn: beaconFields.installedOn,
  notes: beaconFields.notes,
  /** Why the change: required when a beacon moves room or is switched off. */
  reason: ReasonSchema.optional(),
});

export const BeaconQuerySchema = z.strictObject({
  classroomId: z.uuid().optional(),
  status: z.enum(BEACON_STATUSES).optional(),
});

const MeasurementsSchema = z
  .array(
    z.strictObject({
      beaconId: z.uuid(),
      phoneModel: z.string().trim().min(2).max(100),
      platform: z.enum(['ANDROID', 'IOS']),
      position: z.enum(SURVEY_POSITIONS),
      rssi: z.number().int().min(-120).max(0),
    }),
  )
  .min(1)
  .max(2000);

export const CalibrationSurveySchema = z.strictObject({
  classroomId: z.uuid(),
  notes: z.string().trim().max(500).optional(),
  measurements: MeasurementsSchema,
});

/** Another phone's readings, added to a survey that has not been applied yet (each phone measures itself). */
export const AddMeasurementsSchema = z.strictObject({ measurements: MeasurementsSchema });

export const SurveyQuerySchema = z.strictObject({ classroomId: z.uuid().optional() });
export const ApplySurveySchema = z.strictObject({ reason: ReasonSchema.optional() });
