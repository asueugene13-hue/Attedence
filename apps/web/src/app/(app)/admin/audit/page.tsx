'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExportButtons } from '@/components/exports';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { AUDIT_AREAS, describeAction } from '@/lib/audit-actions';
import { useAuth } from '@/lib/auth';
import { formatDateTime, roleLabel } from '@/lib/format';
import type { AuditEntry, Page } from '@/lib/types';

export default function AuditPage() {
  return (
    <PermissionGate permission="audit_logs.read">
      <AuditLog />
    </PermissionGate>
  );
}

function summary(entry: AuditEntry): string {
  const parts: string[] = [];
  if (entry.before && typeof entry.before === 'object') parts.push(`before ${JSON.stringify(entry.before)}`);
  if (entry.after && typeof entry.after === 'object') parts.push(`after ${JSON.stringify(entry.after)}`);
  return parts.join(' · ');
}

function AuditLog() {
  const auth = useAuth();
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState({ action: '', entityId: '', from: '', to: '' });

  const query = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (filters.action) params.set('action', filters.action);
      if (filters.entityId) params.set('entityId', filters.entityId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (pageParam) params.set('cursor', pageParam);
      return auth.call<Page<AuditEntry>>(`/audit-logs?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const entries = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Audit log"
        subtitle="Every sensitive action, newest first. Entries cannot be edited or deleted. Your searches are recorded too."
      />
      <form
        method="post"
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ action: action.trim(), entityId: entityId.trim(), from, to });
        }}
      >
        <div style={{ minWidth: 200 }}>
          <SelectField
            label="Area"
            name="area"
            value={AUDIT_AREAS.some((a) => a.prefix === action) ? action : ''}
            onChange={setAction}
            options={[
              { value: '', label: 'Everything' },
              ...AUDIT_AREAS.map((a) => ({ value: a.prefix, label: a.label })),
            ]}
          />
        </div>
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="audit-action">Action code starts with</label>
          <input
            id="audit-action"
            placeholder="e.g. users. or auth.login"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
        </div>
        <div className="field" style={{ minWidth: 260 }}>
          <label htmlFor="audit-entity">Record ID</label>
          <input id="audit-entity" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="audit-from">From</label>
          <input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="audit-to">To</label>
          <input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary" style={{ alignSelf: 'flex-end' }}>
          Search
        </Button>
      </form>

      <ExportButtons
        label="Download these entries"
        request={{
          reportType: 'AUDIT_LOG',
          params: {
            ...(filters.action ? { action: filters.action } : {}),
            ...(filters.entityId ? { entityId: filters.entityId } : {}),
            ...(filters.from ? { from: filters.from } : {}),
            ...(filters.to ? { to: filters.to } : {}),
          },
        }}
      />
      {query.isError ? <Alert tone="error">{describeError(query.error)}</Alert> : null}
      {query.isPending ? (
        <LoadingState />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">When (Accra)</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">Record</th>
                  <th scope="col">Reason and details</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No entries match.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(entry.occurredAt)}</td>
                      <td>
                        {describeAction(entry.action)}
                        <code style={{ display: 'block', fontSize: 11 }} className="muted">
                          {entry.action}
                        </code>
                      </td>
                      <td>
                        {entry.actor ? entry.actor.email : 'System'}
                        {entry.actorRoleKey ? (
                          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                            {roleLabel(entry.actorRoleKey)}
                          </span>
                        ) : null}
                      </td>
                      <td className="secondary-text">
                        {entry.entityType}
                        {entry.entityId ? (
                          <span style={{ display: 'block', fontSize: 12, wordBreak: 'break-all' }}>
                            {entry.entityId}
                          </span>
                        ) : null}
                      </td>
                      <td className="secondary-text" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                        {entry.reason ? <strong style={{ display: 'block' }}>{entry.reason}</strong> : null}
                        {summary(entry)}
                      </td>
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
