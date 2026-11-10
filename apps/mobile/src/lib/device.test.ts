import { createHash, createPublicKey, verify } from 'node:crypto';
import { DEVICE_HEADERS, deviceSigningPayload } from '@attendsure/shared';
import { deviceIdentity, resetDeviceIdentity, signedHeaders, toBase64Url } from './device';

// In-memory stand-in for the phone's secure storage, and Node's secure random numbers for expo-crypto.
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
jest.mock('expo-crypto', () => ({
  getRandomValues: <T extends Uint8Array>(array: T) =>
    jest.requireActual<typeof import('node:crypto')>('node:crypto').getRandomValues(array) as T,
}));

beforeEach(() => mockStore.clear());

describe('this phone’s identity and signatures', () => {
  it('writes base64url exactly as Node does', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('keeps one identity until it is reset', async () => {
    const first = await deviceIdentity();
    expect(first.installationId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await deviceIdentity()).publicKey).toBe(first.publicKey);
    await resetDeviceIdentity();
    expect((await deviceIdentity()).publicKey).not.toBe(first.publicKey);
  });

  it('makes signatures the server’s check accepts, and only for the exact request', async () => {
    const identity = await deviceIdentity();
    const body = JSON.stringify({ hello: 'world' });
    const path = '/api/v1/me/devices/current';
    const headers = signedHeaders('device-1', identity, 'POST', path, body, 1_900_000_000_000);
    // The server's check (DeviceSignatureGuard): rebuild the text, verify with the public key.
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey },
      format: 'jwk',
    });
    const check = (method: string, checkedPath: string, checkedBody: string) =>
      verify(
        null,
        Buffer.from(
          deviceSigningPayload({
            method,
            path: checkedPath,
            timestamp: headers[DEVICE_HEADERS.timestamp]!,
            nonce: headers[DEVICE_HEADERS.nonce]!,
            bodySha256Hex: createHash('sha256').update(checkedBody).digest('hex'),
          }),
        ),
        key,
        Buffer.from(headers[DEVICE_HEADERS.signature]!, 'base64url'),
      );
    expect(check('POST', path, body)).toBe(true);
    expect(check('POST', path, JSON.stringify({ hello: 'there' }))).toBe(false);
    expect(check('POST', '/api/v1/me/devices', body)).toBe(false);
    expect(check('GET', path, body)).toBe(false);
    expect(headers[DEVICE_HEADERS.timestamp]).toBe('1900000000000');
    expect(headers[DEVICE_HEADERS.nonce]).toMatch(/^[0-9a-f]{32}$/);
  });
});
