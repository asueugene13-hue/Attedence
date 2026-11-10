import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Ed25519 needs SHA-512; the library takes it from @noble/hashes (pure JavaScript, audited).
ed.hashes.sha512 = sha512;

const INSTALLATION_KEY = 'attendsure.installationId';
const SECRET_KEY = 'attendsure.deviceKey';
// Keychain (iOS) and Keystore-backed storage (Android), readable only while the phone is unlocked and
// never copied to backups or other phones (PRESENCE_VERIFICATION.md §5).
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface DeviceIdentity {
  installationId: string;
  secretKey: Uint8Array;
  /** base64url, as the server stores it. */
  publicKey: string;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding (React Native has no Buffer). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((c) => BASE64URL[c]);
    out += chars.slice(0, i + 2 < bytes.length ? 4 : bytes.length - i + 1).join('');
  }
  return out;
}

const randomBytes = (length: number) => Crypto.getRandomValues(new Uint8Array(length));

/**
 * This phone's identity: a random installation ID and an Ed25519 key pair, made on first use and kept
 * in secure storage. The private key never leaves the phone; only the public key is sent.
 */
export async function deviceIdentity(): Promise<DeviceIdentity> {
  let installationId = await SecureStore.getItemAsync(INSTALLATION_KEY, OPTIONS);
  let secretHex = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS);
  if (!installationId || !secretHex) {
    installationId = bytesToHex(randomBytes(16));
    secretHex = bytesToHex(randomBytes(32));
    await SecureStore.setItemAsync(SECRET_KEY, secretHex, OPTIONS);
    await SecureStore.setItemAsync(INSTALLATION_KEY, installationId, OPTIONS);
  }
  const secretKey = hexToBytes(secretHex);
  return { installationId, secretKey, publicKey: toBase64Url(ed.getPublicKey(secretKey)) };
}

/** Forgets this phone's identity; the next registration starts as a new phone (which needs approval). */
export async function resetDeviceIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET_KEY, OPTIONS);
  await SecureStore.deleteItemAsync(INSTALLATION_KEY, OPTIONS);
}

/** What the app sends to register this phone. */
export function registrationBody(identity: DeviceIdentity) {
  return {
    installationId: identity.installationId,
    platform: Platform.OS === 'ios' ? ('IOS' as const) : ('ANDROID' as const),
    osVersion: String(Platform.Version),
    publicKey: identity.publicKey,
  };
}

/**
 * Headers for a request signed by this phone: the server rebuilds the same text from what it
 * receives and checks the signature with the phone's public key.
 */
export function signedHeaders(
  deviceId: string,
  identity: DeviceIdentity,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const timestamp = String(now);
  const nonce = bytesToHex(randomBytes(16));
  const payload = deviceSigningPayload({
    method,
    path,
    timestamp,
    nonce,
    bodySha256Hex: bytesToHex(sha256(utf8ToBytes(body))),
  });
  return {
    [DEVICE_HEADERS.device]: deviceId,
    [DEVICE_HEADERS.timestamp]: timestamp,
    [DEVICE_HEADERS.nonce]: nonce,
    [DEVICE_HEADERS.signature]: toBase64Url(ed.sign(utf8ToBytes(payload), identity.secretKey)),
  };
}
