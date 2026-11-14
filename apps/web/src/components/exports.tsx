'use client';

import type { ExportRequest } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

export interface ExportRow {
  id: string;
  reportType: string;
  title: string | null;
  format: 'CSV' | 'XLSX' | 'PDF';
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  containsPersonalData: boolean;
  rowCount: number | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
  downloadCount: number;
  requestedBy?: string;
}

const STATUS: Record<ExportRow['status'], { label: string; tone: 'info' | 'success' | 'error' | 'neutral' }> =
  {
    QUEUED: { label: 'Waiting', tone: 'info' },
    RUNNING: { label: 'Being made', tone: 'info' },
    READY: { label: 'Ready', tone: 'success' },
    FAILED: { label: 'Not made', tone: 'error' },
    EXPIRED: { label: 'Deleted', tone: 'neutral' },
  };
const FORMAT_LABEL = { CSV: 'CSV', XLSX: 'Excel', PDF: 'PDF' } as const;

/** Buttons that ask for a report file in each format; the file appears in "Your files". */
export function ExportButtons({
  request,
  label,
}: {
  request: Omit<ExportRequest, 'format'>;
  label?: string;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  async function ask(format: ExportRow['format']) {
    setBusy(format);
    setMessage(null);
    try {
      await auth.call('/reports/exports', { method: 'POST', body: { ...request, format } });
      setMessage({ tone: 'success', text: 'Asked for. It appears in “Your files” below when it is ready.' });
      await queryClient.invalidateQueries({ queryKey: ['my-exports'] });
    } catch (e) {
      setMessage({ tone: 'error', text: describeError(e) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack-sm">
      <div className="row" role="group" aria-label={label ?? 'Download as'}>
        <span className="muted">{label ?? 'Download as'}</span>
        {(['CSV', 'XLSX', 'PDF'] as const).map((f) => (
          <Button key={f} size="sm" variant="secondary" busy={busy === f} onClick={() => void ask(f)}>
            {FORMAT_LABEL[f]}
          </Button>
        ))}
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </div>
  );
}

/** The person's report files, newest first; refreshes while any is still being made. */
export function MyExports({ all = false }: { all?: boolean }) {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ['my-exports', all],
    queryFn: () => auth.call<{ data: ExportRow[] }>(`/reports/exports${all ? '?view=ALL' : ''}`),
    refetchInterval: (q) =>
      q.state.data?.data.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? 2000 : false,
  });
  async function download(id: string) {
    setError(null);
    try {
      const link = await auth.call<{ url: string }>(`/reports/exports/${id}/download`);
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      setError(describeError(e));
    }
  }
  if (files.isPending) return <LoadingState />;
  if (files.isError) return <Alert tone="error">{describeError(files.error)}</Alert>;
  return (
    <div className="stack-sm">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Report</th>
              {all ? <th scope="col">Asked by</th> : null}
              <th scope="col">Format</th>
              <th scope="col">Asked</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.data.data.length === 0 ? (
              <tr>
                <td colSpan={all ? 6 : 5} className="muted">
                  No files yet.
                </td>
              </tr>
            ) : (
              files.data.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.title ?? r.reportType}
                    <div className="muted">
                      {r.rowCount !== null ? `${r.rowCount} rows` : ''}
                      {r.containsPersonalData ? ' · contains personal data' : ''}
                    </div>
                  </td>
                  {all ? <td>{r.requestedBy}</td> : null}
                  <td>{FORMAT_LABEL[r.format]}</td>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>
                    <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
                    {r.error ? <div className="muted">{r.error}</div> : null}
                    {r.status === 'READY' && r.expiresAt ? (
                      <div className="muted">Deleted {formatDateTime(r.expiresAt)}</div>
                    ) : null}
                  </td>
                  <td>
                    {!all && r.status === 'READY' ? (
                      <Button size="sm" onClick={() => void download(r.id)}>
                        Download
                      </Button>
                    ) : all ? (
                      <span className="muted">{r.downloadCount} downloads</span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
