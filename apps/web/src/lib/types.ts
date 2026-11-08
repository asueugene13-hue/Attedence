import type { RoleKey } from '@attendsure/shared';

export interface SessionResponse {
  client: 'WEB';
  accessToken: string;
  accessTokenExpiresAt: string;
  sessionExpiresAt: string;
  user: { id: string; email: string; fullName: string };
  activeRole: RoleKey;
  roles: RoleKey[];
  recoveryCodes?: string[];
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

export interface RoleGrantSummary {
  grantId: string;
  role: RoleKey;
  scopeType: 'INSTITUTION' | 'FACULTY' | 'DEPARTMENT';
  scopeId: string | null;
  grantedAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: RoleGrantSummary[];
}

export interface UserDetail extends UserSummary {
  activeSessions: number;
  grantHistory: (RoleGrantSummary & {
    grantedBy: { id: string; email: string } | null;
    revokedAt: string | null;
    revokedBy: { id: string; email: string } | null;
  })[];
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface RoleView {
  key: RoleKey;
  name: string;
  editable: boolean;
  permissions: string[];
  assignable: { key: string; description: string; held: boolean; isDefault: boolean }[];
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorType: 'USER' | 'SYSTEM';
  actorRoleKey: RoleKey | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  actor: { id: string; email: string; fullName: string } | null;
}
