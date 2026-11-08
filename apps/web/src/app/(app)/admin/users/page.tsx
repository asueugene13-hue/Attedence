'use client';

import { ROLE_KEYS } from '@attendsure/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { Alert, Button, LoadingState, PageHeader, UserStatusBadge } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, roleLabel, STATUS_LABELS } from '@/lib/format';
import type { Page, UserSummary } from '@/lib/types';

export default function UsersPage() {
  return (
    <PermissionGate permission="users.manage_admins">
      <UsersList />
    </PermissionGate>
  );
}

function UsersList() {
  const auth = useAuth();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ q: '', status: '', role: '' });

  const query = useInfiniteQuery({
    queryKey: ['users', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (filters.q) params.set('q', filters.q);
      if (filters.status) params.set('status', filters.status);
      if (filters.role) params.set('role', filters.role);
      if (pageParam) params.set('cursor', pageParam);
      return auth.call<Page<UserSummary>>(`/users?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const users = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Accounts"
        subtitle="Staff accounts and their roles. Students and lecturers are added with their academic records."
        actions={
          <Link className="btn btn-primary" href="/admin/users/new">
            New staff account
          </Link>
        }
      />

      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters((f) => ({ ...f, q: search.trim() }));
        }}
      >
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="user-search">Search name or email</label>
          <input id="user-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="user-status">Status</label>
          <select
            id="user-status"
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">Any status</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="user-role">Role</label>
          <select
            id="user-role"
            value={filters.role}
            onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}
          >
            <option value="">Any role</option>
            {ROLE_KEYS.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary" style={{ alignSelf: 'flex-end' }}>
          Search
        </Button>
      </form>

      {query.isError ? <Alert tone="error">{describeError(query.error)}</Alert> : null}
      {query.isPending ? (
        <LoadingState />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No accounts match.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <Link href={`/admin/users/${user.id}`}>{user.fullName}</Link>
                      </td>
                      <td className="secondary-text">{user.email}</td>
                      <td>
                        {user.roles.map((r) => roleLabel(r.role)).join(', ') || (
                          <span className="muted">None</span>
                        )}
                      </td>
                      <td>
                        <UserStatusBadge status={user.status} />
                      </td>
                      <td className="secondary-text">{formatDateTime(user.lastLoginAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {query.hasNextPage ? (
        <Button variant="secondary" busy={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
