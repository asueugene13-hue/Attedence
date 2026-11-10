import { z } from 'zod';
import { ReasonSchema } from './admin.js';

/**
 * Trusted phones (PRESENCE_VERIFICATION.md §5, D-10 decided 2026-11-09). Each phone makes its own
 * Ed25519 key pair; the private key stays in the phone's secure storage and the server keeps only the
 * public key. Requests that need the phone (the classroom check, and check-in in Phase 5) are signed.
 */
export const DEVICE_STATUSES = ['PENDING_APPROVAL', 'TRUSTED', 'REVOKED', 'REPLACED'] as const;
export const DEVICE_PLATFORMS = ['ANDROID', 'IOS'] as const;

/** 32 bytes written base64url, without padding. */
const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 32-byte key in base64url');

export const RegisterDeviceSchema = z.strictObject({
  /** A random ID the app makes on first launch and keeps in secure storage. */
  installationId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'must be 16 to 64 letters, digits or dashes'),
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string().trim().max(100).optional(),
  osVersion: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
  publicKey: PublicKeySchema,
});

export const TrustRequestSchema = z.strictObject({ reason: ReasonSchema });
export const DeviceApproveSchema = z.strictObject({ note: ReasonSchema.optional() });
export const DeviceRefuseSchema = z.strictObject({ reason: ReasonSchema });

export const DeviceListQuerySchema = z.strictObject({
  status: z.enum(DEVICE_STATUSES).optional(),
  /** Requests waiting for a decision only. */
  requested: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  q: z.string().trim().min(2).max(100).optional(),
});

/** The headers a signed request carries. */
export const DEVICE_HEADERS = {
  device: 'x-device-id',
  timestamp: 'x-device-timestamp',
  nonce: 'x-device-nonce',
  signature: 'x-device-signature',
} as const;

/** A signed request older or newer than this (by the server's clock) is refused. */
export const DEVICE_SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

/**
 * The exact text a phone signs: a fixed label, the method, the full path with its query, the time
 * (milliseconds), a single-use random nonce, and the SHA-256 of the body bytes (hex; of "" if none).
 * The server rebuilds it from the request it received, so any change to any part breaks the signature.
 */
export function deviceSigningPayload(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): string {
  return [
    'ATTENDSURE-DEVICE-V1',
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256Hex,
  ].join('\n');
}

export const RISK_TYPES = [
  'SHARED_DEVICE',
  'DEVICE_SWITCH',
  'ACCOUNT_SWITCH',
  'BEACON_LOCATION_CONFLICT',
  'MOCK_LOCATION',
  'INTEGRITY_FAILED',
  'REPEATED_REJECTIONS',
  'UNEXPECTED_BEACON',
] as const;
export type RiskType = (typeof RISK_TYPES)[number];
export const FLAG_STATUSES = ['OPEN', 'DISMISSED', 'CONFIRMED'] as const;

export const RiskFlagQuerySchema = z.strictObject({
  status: z.enum(FLAG_STATUSES).default('OPEN'),
  type: z.enum(RISK_TYPES).optional(),
});

/** A reviewer's decision: confirmed (it was a real problem) or dismissed (it was not), with a note. */
export const ReviewRiskFlagSchema = z.strictObject({
  decision: z.enum(['CONFIRMED', 'DISMISSED']),
  note: ReasonSchema,
});
