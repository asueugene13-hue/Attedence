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
import { tokenStore } from './token-store';
import type { LoginResponse, Me, MfaChallenge, SessionResponse } from './types';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  pendingMfa: MfaChallenge | null;
  /**
   * `identifier` is an email or an 8-digit Student ID (staff numbers also work). Returns the two-step
   * challenge when one is needed, otherwise signs in.
   */
  login(identifier: string, password: string): Promise<MfaChallenge | null>;
  verifyMfa(input: { code?: string; recoveryCode?: string }): Promise<void>;
  cancelMfa(): void;
  logout(): Promise<void>;
  switchRole(role: RoleKey): Promise<void>;
  call<T>(path: string, request?: Omit<ApiRequest, 'accessToken'>): Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const RENEW_BEFORE_EXPIRY_MS = 60_000;

/**
 * Sign-in state for the app. The refresh token (30-day session) is kept in the phone's secure storage;
 * the 15-minute access token stays in memory only.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [pendingMfa, setPendingMfa] = useState<MfaChallenge | null>(null);
  const access = useRef<{ token: string; expiresAt: number } | null>(null);
  const inflight = useRef<Promise<string | null> | null>(null);

  const signOutLocally = useCallback(async () => {
    access.current = null;
    await tokenStore.clear();
    setMe(null);
    setStatus('signed-out');
  }, []);

  const keepSession = useCallback(async (session: SessionResponse) => {
    access.current = { token: session.accessToken, expiresAt: Date.parse(session.accessTokenExpiresAt) };
    await tokenStore.set(session.refreshToken);
  }, []);

  const loadMe = useCallback(async (accessToken: string) => {
    setMe(await apiFetch<Me>('/auth/me', { accessToken }));
    setStatus('signed-in');
  }, []);

  /** Exchanges the stored refresh token for a new pair. One request at a time: tokens work only once. */
  const refresh = useCallback(async (): Promise<string | null> => {
    inflight.current ??= (async () => {
      const stored = await tokenStore.get();
      if (!stored) return null;
      try {
        const session = await apiFetch<SessionResponse>('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: stored },
        });
        await keepSession(session);
        return session.accessToken;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          await tokenStore.clear();
          return null;
        }
        throw error;
      }
    })().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, [keepSession]);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(async (token) => {
        if (cancelled) return;
        if (token) await loadMe(token);
        else setStatus('signed-out');
      })
      // Offline at start-up: show sign-in rather than spin forever; the stored session is kept.
      .catch(() => !cancelled && setStatus('signed-out'));
    return () => {
      cancelled = true;
    };
  }, [refresh, loadMe]);

  const call = useCallback(
    async <T,>(path: string, request: Omit<ApiRequest, 'accessToken'> = {}): Promise<T> => {
      const current = access.current;
      let token =
        current && current.expiresAt - Date.now() > RENEW_BEFORE_EXPIRY_MS ? current.token : await refresh();
      if (!token) {
        await signOutLocally();
        throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
      }
      try {
        return await apiFetch<T>(path, { ...request, accessToken: token });
      } catch (error) {
        // Only an ended sign-in is worth refreshing and retrying. Other 401s, such as a refused phone
        // signature, are final: resending a signed request would only be refused as a replay.
        if (!(error instanceof ApiError) || error.status !== 401 || error.code !== 'UNAUTHENTICATED')
          throw error;
        token = await refresh();
        if (!token) {
          await signOutLocally();
          throw error;
        }
        return apiFetch<T>(path, { ...request, accessToken: token });
      }
    },
    [refresh, signOutLocally],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      pendingMfa,
      async login(identifier, password) {
        const result = await apiFetch<LoginResponse>('/auth/login', {
          method: 'POST',
          body: { identifier, password, client: 'MOBILE' },
        });
        if ('mfaRequired' in result) {
          setPendingMfa(result);
          return result;
        }
        await keepSession(result);
        await loadMe(result.accessToken);
        return null;
      },
      async verifyMfa(input) {
        if (!pendingMfa) throw new ApiError(401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again.');
        const session = await apiFetch<SessionResponse>('/auth/mfa/verify', {
          method: 'POST',
          body: { mfaToken: pendingMfa.mfaToken, ...input },
        });
        setPendingMfa(null);
        await keepSession(session);
        await loadMe(session.accessToken);
      },
      cancelMfa: () => setPendingMfa(null),
      async logout() {
        try {
          await call('/auth/logout', { method: 'POST' });
        } catch {
          // Signing out locally must work even offline; the server session expires on its own.
        } finally {
          await signOutLocally();
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
        access.current = { token: result.accessToken, expiresAt: Date.parse(result.accessTokenExpiresAt) };
        await loadMe(result.accessToken);
      },
      call,
    }),
    [status, me, pendingMfa, keepSession, loadMe, call, signOutLocally],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
