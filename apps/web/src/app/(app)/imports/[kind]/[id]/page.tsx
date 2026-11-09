'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { Counts, SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError, saveBlob } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  batchTone,
  IMPORT_KINDS,
  IMPORT_STATUS_LABELS,
  type ImportBatchView,
  type ImportKind,
  type ImportRowView,
  ROW_STATUS_LABELS,
} from '@/lib/records';

/** The first columns identify a row for the person checking it. */
const KEY_COLUMNS: Record<ImportKind, string[]> = {
  students: ['student_number', 'full_name', 'email'],
  enrollments: ['student_number', 'course_code', 'section_code'],
};

const rowTone = (s: ImportRowView['status']) =>
  s === 'VALID' || s === 'IMPORTED' ? 'success' : s === 'INVALID' ? 'error' : 'warning';

export default function ImportBatchPage() {
  const { kind } = useParams<{ kind: string }>();
  if (!(kind in IMPORT_KINDS)) return <Alert tone="error">No such import type.</Alert>;
  const k = kind as ImportKind;
  return (
    <PermissionGate permission={IMPORT_KINDS[k].permission}>
      <BatchDetail kind={k} />
    </PermissionGate>
  );
}

function BatchDetail({ kind }: { kind: ImportKind }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const [busy, setBusy] = useState<'confirm' | 'cancel' | 'retry' | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const batch = useQuery({
    queryKey: ['import', kind, id],
    queryFn: () => auth.call<ImportBatchView>(`/imports/${kind}/${id}`),
    // While activation emails are going out, show progress.
    refetchInterval: (q) => ((q.state.data?.activationEmails?.pending ?? 0) > 0 ? 3000 : false),
  });

  async function act(action: 'confirm' | 'cancel' | 'activation-emails') {
    setBusy(action === 'activation-emails' ? 'retry' : action);
    setError(null);
    try {
      await auth.call(`/imports/${kind}/${id}/${action}`, { method: 'POST', body: {} });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['import', kind, id] }),
        queryClient.invalidateQueries({ queryKey: ['import-rows', kind, id] }),
        queryClient.invalidateQueries({ queryKey: ['imports', kind] }),
        queryClient.invalidateQueries({ queryKey: [kind] }),
      ]);
      setConfirmingCancel(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function report(format: 'csv' | 'xlsx') {
    setError(null);
    try {
      const blob = await auth.call<Blob>(`/imports/${kind}/${id}/error-report?format=${format}`, {
        responseType: 'blob',
      });
      saveBlob(blob, `import-problems.${format}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (batch.isPending) return <LoadingState />;
  if (batch.isError) return <Alert tone="error">{describeError(batch.error)}</Alert>;
  const b = batch.data;
  const problemRows = b.invalidRows + b.duplicateRows;
  const emails = b.activationEmails;

  return (
    <div className="stack">
      <PageHeader
        title={`${IMPORT_KINDS[kind].label} import`}
        subtitle={`${b.fileName ?? 'Uploaded file'} · uploaded ${formatDateTime(b.createdAt)} by ${b.uploadedBy.fullName}`}
        actions={
          <Link className="btn btn-secondary" href={`/imports?type=${kind}`}>
            All imports
          </Link>
        }
      />

      <section className="card" aria-labelledby="summary-heading">
        <div className="card-header row">
          <h2 id="summary-heading">Summary</h2>
          <span className="spacer" />
          <StatusBadge tone={batchTone(b.status)} label={IMPORT_STATUS_LABELS[b.status]} />
        </div>
        <div className="card-body stack">
          <Counts
            items={[
              { label: 'Rows', value: b.totalRows },
              { label: 'Ready', value: b.validRows },
              { label: 'With problems', value: b.invalidRows },
              { label: 'Duplicates', value: b.duplicateRows },
              { label: 'Imported', value: b.importedRows },
            ]}
          />
          {b.status === 'VALIDATED' ? (
            <>
              <Alert tone="info">
                Nothing has been saved yet. Confirming saves the {b.validRows} ready rows in one go and
                re-checks them first; rows with problems or duplicates are skipped. You can fix those in the
                error report and upload it again.
              </Alert>
              {confirmingCancel ? (
                <div className="row">
                  <span>Discard this file? Its stored copy is deleted.</span>
                  <span className="spacer" />
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmingCancel(false)}
                    disabled={busy !== null}
                  >
                    Keep it
                  </Button>
                  <Button variant="danger" busy={busy === 'cancel'} onClick={() => act('cancel')}>
                    Discard file
                  </Button>
                </div>
              ) : (
                <div className="row">
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmingCancel(true)}
                    disabled={busy !== null}
                  >
                    Cancel import
                  </Button>
                  <span className="spacer" />
                  <Button
                    busy={busy === 'confirm'}
                    busyLabel="Importing…"
                    disabled={b.validRows === 0}
                    onClick={() => act('confirm')}
                  >
                    Import {b.validRows} ready {b.validRows === 1 ? 'row' : 'rows'}
                  </Button>
                </div>
              )}
              {b.validRows === 0 ? (
                <p className="muted">No row is ready to import. Fix the file and upload it again.</p>
              ) : null}
            </>
          ) : null}
          {problemRows > 0 ? (
            <div className="row">
              <span>Download the {problemRows} rows that were not imported, with the reason for each:</span>
              <Button variant="ghost" size="sm" onClick={() => report('xlsx')}>
                Error report (.xlsx)
              </Button>
              <Button variant="ghost" size="sm" onClick={() => report('csv')}>
                Error report (CSV)
              </Button>
            </div>
          ) : null}
          {emails && b.status === 'COMPLETED' && emails.pending + emails.sent + emails.failed > 0 ? (
            <div className="stack-sm">
              <strong>Activation emails</strong>
              <span className="secondary-text">
                {emails.sent} sent · {emails.pending} waiting · {emails.failed} failed
              </span>
              {emails.failed > 0 && kind === 'students' ? (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={busy === 'retry'}
                    onClick={() => act('activation-emails')}
                  >
                    Send the {emails.failed} failed emails again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </section>

      <Rows kind={kind} id={id} />
    </div>
  );
}

function Rows({ kind, id }: { kind: ImportKind; id: string }) {
  const auth = useAuth();
  const [status, setStatus] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['import-rows', kind, id, status],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '100' });
      if (status) params.set('status', status);
      if (pageParam) params.set('after', String(pageParam));
      return auth.call<{ data: ImportRowView[]; nextAfter: number | null }>(
        `/imports/${kind}/${id}/rows?${params}`,
      );
    },
    getNextPageParam: (last) => last.nextAfter,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  const columns = KEY_COLUMNS[kind];

  return (
    <section className="card" aria-labelledby="rows-heading">
      <div className="card-header row">
        <h2 id="rows-heading">Rows</h2>
        <span className="spacer" />
        <SelectField
          label="Show"
          name="rowStatus"
          value={status}
          onChange={setStatus}
          placeholder="All rows"
          options={Object.entries(ROW_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </div>
      {query.isError ? <Alert tone="error">{describeError(query.error)}</Alert> : null}
      {query.isPending ? (
        <div className="card-body">
          <LoadingState />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Status</th>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c.replace(/_/g, ' ')}
                  </th>
                ))}
                <th scope="col">Problems</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 3} className="muted">
                    No rows to show.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.rowNumber}>
                    <td>{r.rowNumber}</td>
                    <td>
                      <StatusBadge tone={rowTone(r.status)} label={ROW_STATUS_LABELS[r.status]} />
                    </td>
                    {columns.map((c) => (
                      <td key={c} className="secondary-text">
                        {r.raw[c] || '—'}
                      </td>
                    ))}
                    <td>
                      {r.errors?.length ? (
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {r.errors.map((e, i) => (
                            <li key={i}>{e.message}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {query.hasNextPage ? (
        <div className="card-body">
          <Button variant="secondary" busy={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            Show more rows
          </Button>
        </div>
      ) : null}
    </section>
  );
}
