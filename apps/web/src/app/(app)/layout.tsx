'use client';

import type { RoleKey } from '@attendsure/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Alert, BrandMark, Button, LoadingState } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { roleLabel } from '@/lib/format';
import { visibleNavItems } from '@/lib/navigation';

export default function AppLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (auth.status === 'signed-out') router.replace('/login');
  }, [auth.status, router]);

  if (auth.status !== 'signed-in' || !auth.me) {
    return (
      <main className="auth-page">
        <LoadingState label="Checking your sign-in…" />
      </main>
    );
  }

  const me = auth.me;
  const items = visibleNavItems(me.permissions);

  async function changeRole(role: RoleKey) {
    setSwitching(true);
    setError(null);
    try {
      await auth.switchRole(role);
      router.push('/');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div style={{ padding: '0 8px' }}>
          <BrandMark />
        </div>
        <nav aria-label="Main">
          {items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="nav-link"
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div style={{ padding: '0 10px' }} className="stack-sm">
            <div>
              <strong style={{ display: 'block', fontSize: 13 }}>{me.user.fullName}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {me.user.email}
              </span>
            </div>
            {me.roles.length > 1 ? (
              <div className="field">
                <label htmlFor="active-role">Acting as</label>
                <select
                  id="active-role"
                  value={me.activeRole}
                  disabled={switching}
                  onChange={(e) => changeRole(e.target.value as RoleKey)}
                >
                  {me.roles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <span className="badge badge-info" style={{ alignSelf: 'flex-start' }}>
                {roleLabel(me.activeRole)}
              </span>
            )}
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Link
            href="/account/password"
            className="nav-link"
            aria-current={pathname === '/account/password' ? 'page' : undefined}
          >
            Change password
          </Link>
          <Button variant="secondary" onClick={() => auth.logout().then(() => router.replace('/login'))}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
