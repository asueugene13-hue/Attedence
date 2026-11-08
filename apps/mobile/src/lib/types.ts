import type { RoleKey } from '@attendsure/shared';

export interface SessionResponse {
  client: 'MOBILE';
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  sessionExpiresAt: string;
  user: { id: string; email: string; fullName: string };
  activeRole: RoleKey;
  roles: RoleKey[];
}

export interface MfaChallenge {
  mfaRequired: true;
  enrollmentRequired: boolean;
  mfaToken: string;
}

export type LoginResponse = SessionResponse | MfaChallenge;

export interface Me {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  activeRole: RoleKey;
  roles: RoleKey[];
  permissions: string[];
}
