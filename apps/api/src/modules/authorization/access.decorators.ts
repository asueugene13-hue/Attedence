import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@attendsure/shared';

export const ACCESS_RULE = 'attendsure:access-rule';

/**
 * Every route must say who may call it. A route with no rule is refused, even for the Super Admin,
 * so forgetting a decorator fails safe instead of opening a hole (docs/ROLE_PERMISSION_MATRIX.md).
 */
export type AccessRule =
  { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permissions'; keys: readonly PermissionKey[] };

/** No sign-in needed (sign-in itself, password reset, health checks). */
export const Public = () => SetMetadata(ACCESS_RULE, { kind: 'public' } satisfies AccessRule);

/** Any signed-in user, whatever their role (their own profile, signing out). */
export const Authenticated = () => SetMetadata(ACCESS_RULE, { kind: 'authenticated' } satisfies AccessRule);

/** The active role must hold every listed permission. Scope checks happen in the service. */
export const RequirePermissions = (...keys: [PermissionKey, ...PermissionKey[]]) =>
  SetMetadata(ACCESS_RULE, { kind: 'permissions', keys } satisfies AccessRule);
