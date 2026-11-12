'use client';

import type { RoleKey } from '@attendsure/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, apiFetch, type ApiRequest } from './api';
import type { LoginResponse, Me, MfaChallenge, SessionResponse } from './types';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  /** The two-step challenge waiting for a code, between the password step and the code step. */
  pendingMfa: MfaChallenge | null;
  /** `identifier`: an email, an 8-digit Student ID or a staff number. */
  login(identifier: string, password: string): Promise<LoginResponse>;
  completeSession(session: SessionResponse): Promise<void>;
  setPendingMfa(challenge: MfaChallenge | null): void;
  logout(): Promise<void>;
  switchRole(role: RoleKey): Promise<void>;
  /** Calls the API as the signed-in user, renewing the access token once if it has expired. */
  call<T>(path: string, request?: Omit<ApiRequest, 'accessToken'>): Promise<T>;
  /** A valid access token (renewed if needed), for live connections, which cannot use `call`. */
  liveToken(): Promise<string | null>;
  can(permission: string): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Renew a little before the 15-minute access token runs out. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;

/**
 * Runs `task` while holding a lock shared by every tab of this browser. Refresh tokens work once, so two
 * tabs renewing at the same moment would look like a stolen token and end the session. With the lock,
 * the second tab waits, and its request then carries the cookie the first tab just received.
 */
async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('attendsure-refresh', task);
  }
  return task();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [pendingMfa, setPendingMfa] = useState<MfaChallenge | null>(null);
  // The access token lives in memory only, never in localStorage, so page scripts cannot leak it later.
  const token = useRef<{ value: string; expiresAt: number } | null>(null);
  const inflight = useRef<Promise<string | null> | null>(null);

  const signOutLocally = useCallback(() => {
    token.current = null;
    setMe(null);
    setStatus('signed-out');
  }, []);

  const loadMe = useCallback(async (accessToken: string) => {
    const profile = await apiFetch<Me>('/auth/me', { accessToken });
    setMe(profile);
    setStatus('signed-in');
  }, []);

  const storeSession = useCallback((session: { accessToken: string; accessTokenExpiresAt: string }) => {
    token.current = { value: session.accessToken, expiresAt: Date.parse(session.accessTokenExpiresAt) };
  }, []);

  const refresh = useCallback(async (): Promise<string | null> => {
    inflight.current ??= withRefreshLock(async () => {
      try {
        const session = await apiFetch<SessionResponse>('/auth/refresh', { method: 'POST', body: {} });
        storeSession(session);
        return session.accessToken;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
        throw error;
      }
    }).finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, [storeSession]);

  const validToken = useCallback(async (): Promise<string | null> => {
    const current = token.current;
    if (current && current.expiresAt - Date.now() > RENEW_BEFORE_EXPIRY_MS) return current.value;
    return refresh();
  }, [refresh]);

  // On page load: the access token is gone (memory only), so try the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(async (accessToken) => {
        if (cancelled) return;
        if (accessToken) await loadMe(accessToken);
        else signOutLocally();
      })
      .catch(() => {
        if (!cancelled) signOutLocally();
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, loadMe, signOutLocally]);

  const call = useCallback(
    async <T,>(path: string, request: Omit<ApiRequest, 'accessToken'> = {}): Promise<T> => {
      const accessToken = await validToken();
      if (!accessToken) {
        signOutLocally();
        throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
      }
      try {
        return await apiFetch<T>(path, { ...request, accessToken });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        // The session may have been renewed elsewhere; try once more with a fresh token.
        token.current = null;
        const retryToken = await refresh();
        if (!retryToken) {
          signOutLocally();
          throw error;
        }
        return apiFetch<T>(path, { ...request, accessToken: retryToken });
      }
    },
    [validToken, refresh, signOutLocally],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      pendingMfa,
      setPendingMfa,
      async login(identifier, password) {
        return apiFetch<LoginResponse>('/auth/login', {
          method: 'POST',
          body: { identifier, password, client: 'WEB' },
        });
      },
      async completeSession(session) {
        storeSession(session);
        setPendingMfa(null);
        await loadMe(session.accessToken);
      },
      async logout() {
        try {
          await call<void>('/auth/logout', { method: 'POST' });
        } finally {
          signOutLocally();
        }
      },
      async switchRole(role) {
        const result = await call<{ accessToken: string; accessTokenExpiresAt: string }>(
          '/auth/switch-role',
          {
            method: 'POST',
            body: { role },
          },
        );
        storeSession(result);
        await loadMe(result.accessToken);
      },
      call,
      liveToken: validToken,
      can: (permission) => me?.permissions.includes(permission) ?? false,
    }),
    [status, me, pendingMfa, call, validToken, loadMe, signOutLocally, storeSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
