'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  classLabel,
  classTime,
  ISSUE_TYPE_LABELS,
  REVIEW_DECISION_LABELS,
  type ReviewView,
} from '@/lib/classes';
import { formatDateTime } from '@/lib/format';

export default function ReviewQueuePage() {
  return (
    <PermissionGate permission="class_reviews.decide">
      <ReviewQueue />
    </PermissionGate>
  );
}

/** Classes waiting for an administrator's decision: priority first, then the oldest. */
function ReviewQueue() {
  const auth = useAuth();
  const [status, setStatus] = useState('OPEN');
  const reviews = useQuery({
    queryKey: ['class-reviews', status],
    queryFn: () => auth.call<{ data: ReviewView[] }>(`/class-reviews?status=${status}`),
    refetchInterval: 30_000,
  });

  return (
    <div className="stack">
      <PageHeader
        title="Class reviews"
        subtitle="Classes the system or an administrator referred for a decision. Priority reviews (a course rep reported, or a verbal cancellation) come first."
      />
      <SelectField
        label="Show"
        name="status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'OPEN', label: 'Waiting for a decision' },
          { value: 'DECIDED', label: 'Decided' },
        ]}
      />
      {reviews.isPending ? <LoadingState /> : null}
      {reviews.isError ? <Alert tone="error">{describeError(reviews.error)}</Alert> : null}
      {reviews.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Class</th>
                <th scope="col">Why</th>
                <th scope="col">Reports</th>
                <th scope="col">{status === 'OPEN' ? 'Opened' : 'Decision'}</th>
              </tr>
            </thead>
            <tbody>
              {reviews.data.data.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {status === 'OPEN' ? 'Nothing is waiting for a decision.' : 'No decided reviews yet.'}
                  </td>
                </tr>
              ) : (
                reviews.data.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.isPriority ? <StatusBadge tone="error" label="Priority" /> : null}{' '}
                      <Link href={`/class-reviews/${r.id}`}>
                        {r.classSession ? classLabel(r.classSession) : 'Class'}
                      </Link>
                      <div className="muted">{r.classSession ? classTime(r.classSession) : ''}</div>
                    </td>
                    <td>{r.reasons.join(' ')}</td>
                    <td>
                      {Object.entries(r.reportCounts ?? {})
                        .map(
                          ([type, n]) =>
                            `${ISSUE_TYPE_LABELS[type as keyof typeof ISSUE_TYPE_LABELS] ?? type}: ${n}`,
                        )
                        .join(', ') || '—'}
                    </td>
                    <td>
                      {status === 'OPEN'
                        ? formatDateTime(r.openedAt)
                        : `${REVIEW_DECISION_LABELS[r.decision ?? ''] ?? r.decision} · ${formatDateTime(r.decidedAt)}`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
