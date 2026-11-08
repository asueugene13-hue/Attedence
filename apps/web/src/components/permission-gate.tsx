'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { Alert } from './ui';

/** Hides a screen the active role cannot use. A convenience only: the API refuses the requests anyway. */
export function PermissionGate({ permission, children }: { permission: string; children: ReactNode }) {
  const auth = useAuth();
  if (!auth.can(permission)) {
    return <Alert tone="warning">Your current role does not have access to this page.</Alert>;
  }
  return <>{children}</>;
}
