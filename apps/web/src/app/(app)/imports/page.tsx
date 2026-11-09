'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { ApiError, describeError, saveBlob } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  batchTone,
  IMPORT_KINDS,
  IMPORT_STATUS_LABELS,
  type ImportBatchView,
  type ImportKind,
} from '@/lib/records';
import type { Page } from '@/lib/types';

export default function ImportsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Imports />
    </Suspense>
  );
}

function Imports() {
  const auth = useAuth();
  const requested = useSearchParams().get('type');
  const allowed = (Object.keys(IMPORT_KINDS) as ImportKind[]).filter((k) =>
    auth.can(IMPORT_KINDS[k].permission),
  );
  const kind = allowed.find((k) => k === requested) ?? allowed[0];

  if (!kind) return <Alert tone="warning">Your current role does not have access to this page.</Alert>;
  return (
    <div className="stack">
      <PageHeader
        title="Bulk import"
        subtitle="Upload a filled template. Every row is checked first; nothing is saved until you confirm."
      />
      {allowed.length > 1 ? (
        <nav className="row" aria-label="Import type">
          {allowed.map((k) => (
            <Link
              key={k}
              href={`/imports?type=${k}`}
              className={`btn btn-sm ${k === kind ? 'btn-primary' : 'btn-secondary'}`}
              aria-current={k === kind ? 'page' : undefined}
            >
              {IMPORT_KINDS[k].label}
            </Link>
          ))}
        </nav>
      ) : null}
      <UploadCard kind={kind} />
      <History kind={kind} />
    </div>
  );
}

function UploadCard({ kind }: { kind: ImportKind }) {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ missing?: string[]; unknown?: string[] } | null>(null);

  async function template(format: 'csv' | 'xlsx') {
    setError(null);
    try {
      const blob = await auth.call<Blob>(`/imports/${kind}/template?format=${format}`, {
        responseType: 'blob',
      });
      saveBlob(blob, `${kind}-import-template.${format}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setProblems(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const batch = await auth.call<ImportBatchView>(`/imports/${kind}`, { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['imports', kind] });
      router.push(`/imports/${kind}/${batch.id}`);
    } catch (err) {
      setError(describeError(err));
      if (err instanceof ApiError && err.details && typeof err.details === 'object') {
        setProblems(err.details as { missing?: string[]; unknown?: string[] });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="upload-heading">
      <div className="card-header">
        <h2 id="upload-heading">Import {IMPORT_KINDS[kind].noun}</h2>
      </div>
      <div className="card-body stack">
        <ol className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Download the template:{' '}
            <Button variant="ghost" size="sm" onClick={() => template('xlsx')}>
              Excel (.xlsx)
            </Button>{' '}
            <Button variant="ghost" size="sm" onClick={() => template('csv')}>
              CSV
            </Button>
          </li>
          <li>
            Fill one row per {kind === 'students' ? 'student' : 'enrolment'}. Keep the header row as it is.
          </li>
          <li>Upload it here (up to 5 MB and 5,000 rows) and check the preview before confirming.</li>
        </ol>
        <form className="row" onSubmit={upload}>
          <div className="field">
            <label htmlFor="import-file">File</label>
            <input
              id="import-file"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <Button
            type="submit"
            busy={busy}
            busyLabel="Checking…"
            disabled={!file}
            style={{ alignSelf: 'flex-end' }}
          >
            Upload and check
          </Button>
        </form>
        {error ? (
          <Alert tone="error">
            {error}
            {problems?.missing?.length ? <div>Missing columns: {problems.missing.join(', ')}</div> : null}
            {problems?.unknown?.length ? <div>Unknown columns: {problems.unknown.join(', ')}</div> : null}
          </Alert>
        ) : null}
      </div>
    </section>
  );
}

function History({ kind }: { kind: ImportKind }) {
  const auth = useAuth();
  const query = useInfiniteQuery({
    queryKey: ['imports', kind],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      auth.call<Page<ImportBatchView>>(`/imports/${kind}?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const batches = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section className="card" aria-labelledby="history-heading">
      <div className="card-header">
        <h2 id="history-heading">Earlier imports</h2>
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
                <th scope="col">Uploaded</th>
                <th scope="col">File</th>
                <th scope="col">Rows</th>
                <th scope="col">Imported</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No imports yet.
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/imports/${kind}/${b.id}`}>{formatDateTime(b.createdAt)}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {b.uploadedBy.fullName}
                      </div>
                    </td>
                    <td className="secondary-text">{b.fileName ?? '—'}</td>
                    <td>{b.totalRows}</td>
                    <td>{b.importedRows}</td>
                    <td>
                      <StatusBadge tone={batchTone(b.status)} label={IMPORT_STATUS_LABELS[b.status]} />
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
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
