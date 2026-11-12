import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, describeError } from './api';
import { useAuth } from './auth';
import {
  type DeviceIdentity,
  deviceIdentity,
  registrationBody,
  resetDeviceIdentity,
  signedHeaders,
} from './device';

export interface DeviceView {
  id: string;
  status: 'PENDING_APPROVAL' | 'TRUSTED' | 'REVOKED' | 'REPLACED';
  isAttendanceDevice: boolean;
  trustRequestedAt: string | null;
  revokeReason: string | null;
}

interface DeviceContextValue {
  /** This phone as the server knows it, once registered and its key proven. */
  device: DeviceView | null;
  error: string | null;
  /** A request signed by this phone (PRESENCE_VERIFICATION.md §5). */
  callSigned<T>(
    path: string,
    request?: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  ): Promise<T>;
  requestTrust(reason: string): Promise<void>;
  refresh(): Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

/**
 * Registers this phone after each sign-in, then checks it really holds its key with one signed
 * request. If the server knows this installation with another key (for example after storage was
 * cleared), the phone starts over as a new phone, which then needs approval (D-10).
 */
export function DeviceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { call } = auth;
  const identity = useRef<DeviceIdentity | null>(null);
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const callSigned = useCallback(
    async <T,>(
      path: string,
      request: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {},
      as?: DeviceView,
    ) => {
      const current = as ?? device;
      if (!identity.current || !current)
        throw new ApiError(0, 'DEVICE_NOT_READY', 'This phone is not registered yet.');
      const method = request.method ?? 'GET';
      const body = request.body === undefined ? '' : JSON.stringify(request.body);
      const headers = signedHeaders(current.id, identity.current, method, `/api/v1${path}`, body);
      // Extra headers (such as Idempotency-Key) are not part of the signed text.
      return call<T>(path, {
        method,
        headers: { ...request.headers, ...headers },
        ...(body ? { rawBody: body } : {}),
      });
    },
    [call, device],
  );

  const register = useCallback(async () => {
    setError(null);
    try {
      identity.current = await deviceIdentity();
      let registered: DeviceView;
      try {
        registered = await call<DeviceView>('/me/devices', {
          method: 'POST',
          body: registrationBody(identity.current),
        });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'DEVICE_KEY_MISMATCH') throw e;
        await resetDeviceIdentity();
        identity.current = await deviceIdentity();
        registered = await call<DeviceView>('/me/devices', {
          method: 'POST',
          body: registrationBody(identity.current),
        });
      }
      // Prove the key: the server checks this phone's signature and returns its current status.
      setDevice(await callSigned<DeviceView>('/me/devices/current', {}, registered));
    } catch (e) {
      setDevice(null);
      setError(describeError(e));
    }
  }, [call, callSigned]);

  // Register again whenever a different person signs in on this phone (and only then).
  const registerRef = useRef(register);
  registerRef.current = register;
  const signedIn = auth.status === 'signed-in' && Boolean(auth.me);
  const userId = auth.me?.user.id;
  useEffect(() => {
    if (signedIn) void registerRef.current();
    else setDevice(null);
  }, [signedIn, userId]);

  const requestTrust = useCallback(
    async (reason: string) => {
      if (!device) throw new ApiError(0, 'DEVICE_NOT_READY', 'This phone is not registered yet.');
      setDevice(
        await call<DeviceView>(`/me/devices/${device.id}/request-trust`, {
          method: 'POST',
          body: { reason },
        }),
      );
    },
    [call, device],
  );

  return (
    <DeviceContext.Provider value={{ device, error, callSigned, requestTrust, refresh: register }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice(): DeviceContextValue {
  const value = useContext(DeviceContext);
  if (!value) throw new Error('useDevice must be used inside DeviceProvider');
  return value;
}
