import { z } from 'zod';
import { ReasonSchema } from './admin.js';

/**
 * Institution settings (Phase 3). Each has a validated value and a default; a setting nobody has
 * changed uses its default. Changing one needs a reason and is audited. The monitoring values are
 * decision D-13 (product owner, 2026-11-09).
 */
export const SETTINGS = {
  'monitoring.unconfirmedAfterMinutes': {
    label: 'Class becomes unconfirmed after (minutes)',
    description:
      'Minutes after the (expected) start with no lecturer activity before a class becomes UNCONFIRMED.',
    schema: z.number().int().min(5).max(120),
    default: 15,
  },
  'monitoring.reviewAfterMinutes': {
    label: 'Unresolved class goes to review after (minutes)',
    description:
      'Minutes after the (expected) start before an unresolved class goes to an administrator for review.',
    schema: z.number().int().min(10).max(240),
    default: 30,
  },
  'monitoring.reportMinStudents': {
    label: 'Early review: minimum reporting students',
    description: 'At least this many different students must report a problem for an early review.',
    schema: z.number().int().min(1).max(100),
    default: 3,
  },
  'monitoring.reportMinPercent': {
    label: 'Early review: minimum share of the class (%)',
    description: 'The reporting students must also be at least this share of the enrolled class.',
    schema: z.number().min(1).max(100),
    default: 10,
  },
  'monitoring.repCorroboratingStudents': {
    label: 'Early review with a course rep: other students needed',
    description:
      'A course rep’s report plus at least this many other students reporting a problem sends an unconfirmed class to review early. A rep alone never does (D-13).',
    schema: z.number().int().min(1).max(20),
    default: 1,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

export const SettingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);
export const UpdateSettingSchema = z.strictObject({ value: z.unknown(), reason: ReasonSchema });

export const SystemEventQuerySchema = z.strictObject({
  unacknowledged: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
