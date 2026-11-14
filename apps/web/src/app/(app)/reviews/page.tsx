'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { RECORD_DISPLAY, type RecordStatus } from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

type Status = 'SUBMITTED' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';
const STATUS: Record<Status, { label: string; tone: Tone }> = {
  SUBMITTED: { label: 'Waiting for you', tone: 'warning' },
  INFO_REQUESTED: { label: 'Waiting for the student', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'error' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
const CATEGORY: Record<string, string> = {
  MEDICAL: 'Medical',
  BEREAVEMENT: 'Bereavement',
  OFFICIAL_UNIVERSITY_DUTY: 'Official university duty',
  OTHER: 'Other',
};
interface Person {
  id: string;
  studentNumber: string;
  fullName: string;
}
interface Message {
  kind: 'QUESTION' | 'REPLY';
  body: string;
  by: string;
  at: string;
}
interface Attachment {
  fileId: string;
  name: string | null;
  mimeType: string;
  sizeBytes: number;
}
interface Dispute {
  id: string;
  status: Status;
  reason: string;
  submittedAt: string;
  waitingSince: string | null;
  escalatedAt: string | null;
  decisionNote: string | null;
  outcome: string | null;
  record: { id: string; statusWhenDisputed: RecordStatus; status: RecordStatus | null };
  class: {
    id: string;
    scheduledStart: string;
    course: { code: string; title: string } | null;
    sectionCodes: string[];
  } | null;
  student: Person;
  messages?: Message[];
  attachments?: Attachment[];
  attempts?: { receivedAt: string; outcome: string; reason: string | null }[];
}
interface Excuse {
  id: string;
  status: Status;
  category: string;
  description: string;
  startDate: string;
  endDate: string;
  submittedAt: string;
  decisionNote: string | null;
  classCount: number;
  excusedCount: number;
  student: Person;
  classes?: {
    classSessionId: string;
    scheduledStart: string | null;
    course: { code: string; title: string } | null;
    included: boolean | null;
    recordStatus: RecordStatus | null;
  }[];
  messages?: Message[];
  attachments?: Attachment[];
}
type Kind = 'dispute' | 'excuse';

export default function ReviewsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Reviews />
    </Suspense>
  );
}

/**
 * Disputes (the class's lecturer, or administrators in scope; D-21) and excuse requests
 * (administrators in scope only; D-22). Nothing changes until someone decides.
 */
function Reviews() {
  const auth = useAuth();
  const params = useSearchParams();
  const isAdmin = auth.me?.activeRole === 'SUPER_ADMIN' || auth.me?.activeRole === 'UNIVERSITY_ADMIN';
  const [kind, setKind] = useState<Kind>(params.get('excuse') && isAdmin ? 'excuse' : 'dispute');
  const [state, setState] = useState('OPEN');
  const [selected, setSelected] = useState<string | null>(params.get('dispute') ?? params.get('excuse'));
  const base = kind === 'dispute' ? '/disputes' : '/excuse-requests';
  const list = useQuery({
    queryKey: ['reviews', kind, state],
    queryFn: () => auth.call<{ data: (Dispute | Excuse)[] }>(`${base}?state=${state}`),
  });

  return (
    <div className="stack">
      <PageHeader
        title="Disputes and excuse requests"
        subtitle={
          isAdmin
            ? 'Disputes about classes in your scope, and excuse requests from your students. Excuse details stay private: lecturers see only “Excused”.'
            : 'Disputes about your classes. Excuse requests are decided by administrators.'
        }
      />
      <div className="row" role="tablist" aria-label="Kind">
        <Button
          role="tab"
          aria-selected={kind === 'dispute'}
          variant={kind === 'dispute' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            setKind('dispute');
            setSelected(null);
          }}
        >
          Disputes
        </Button>
        {isAdmin ? (
          <Button
            role="tab"
            aria-selected={kind === 'excuse'}
            variant={kind === 'excuse' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setKind('excuse');
              setSelected(null);
            }}
          >
            Excuse requests
          </Button>
        ) : null}
        <div style={{ minWidth: 200 }}>
          <SelectField
            label="Show"
            name="state"
            value={state}
            onChange={setState}
            options={[
              { value: 'OPEN', label: 'Open' },
              { value: 'DECIDED', label: 'Decided' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        </div>
      </div>
      {list.isPending ? <LoadingState /> : null}
      {list.isError ? <Alert tone="error">{describeError(list.error)}</Alert> : null}
      {list.data ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <section className="card" aria-label="List" style={{ flex: '1 1 300px', minWidth: 0 }}>
            {list.data.data.length === 0 ? <p className="card-body muted">Nothing here.</p> : null}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {list.data.data.map((r) => (
                <li key={r.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                  <button
                    type="button"
                    className="list-button"
                    aria-current={selected === r.id ? 'true' : undefined}
                    onClick={() => setSelected(r.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 16px',
                      border: 0,
                      background: selected === r.id ? 'var(--color-primary-tint)' : 'transparent',
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <strong>{r.student.fullName}</strong>{' '}
                    <span className="muted">{r.student.studentNumber}</span>
                    <div className="muted">
                      {'reason' in r
                        ? `${r.class?.course?.code ?? 'Class'} · ${r.class ? formatDateTime(r.class.scheduledStart) : ''}`
                        : `${CATEGORY[r.category] ?? r.category} · ${r.startDate}${r.endDate !== r.startDate ? ` to ${r.endDate}` : ''} · ${r.classCount} class${r.classCount === 1 ? '' : 'es'}`}
                    </div>
                    <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
                    {'escalatedAt' in r && r.escalatedAt ? (
                      <div className="muted">Passed to administrators after 72 hours</div>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Details" style={{ flex: '999 1 520px', minWidth: 0 }}>
            {selected ? (
              <Detail kind={kind} id={selected} />
            ) : (
              <p className="muted">Choose one from the list to see it in full.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ kind, id }: { kind: Kind; id: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const base = kind === 'dispute' ? `/disputes/${id}` : `/excuse-requests/${id}`;
  const detail = useQuery({
    queryKey: ['reviews', kind, 'one', id],
    queryFn: () => auth.call<Dispute | Excuse>(base),
  });
  const [dialog, setDialog] = useState<'ask' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reviews'] });

  async function openFile(fileId: string) {
    setError(null);
    try {
      const link = await auth.call<{ url: string }>(`${base}/attachments/${fileId}`);
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      setError(describeError(e));
    }
  }

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <Alert tone="error">{describeError(detail.error)}</Alert>;
  const r = detail.data;
  const dispute = kind === 'dispute' ? (r as Dispute) : null;
  const excuse = kind === 'excuse' ? (r as Excuse) : null;
  const open = r.status === 'SUBMITTED' || r.status === 'INFO_REQUESTED';
  return (
    <div className="card">
      <div className="card-header">
        <h2>
          {r.student.fullName} · {r.student.studentNumber}
        </h2>
        <div className="muted">
          {dispute
            ? `${dispute.class?.course ? `${dispute.class.course.code} · ${dispute.class.course.title}` : 'Class'} · ${dispute.class ? formatDateTime(dispute.class.scheduledStart) : ''}`
            : `${CATEGORY[excuse!.category] ?? excuse!.category} · ${excuse!.startDate} to ${excuse!.endDate}`}
        </div>
      </div>
      <div className="card-body stack">
        <div className="row">
          <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
          {dispute?.record.status ? (
            <StatusBadge
              tone={RECORD_DISPLAY[dispute.record.status].tone}
              label={`Record: ${RECORD_DISPLAY[dispute.record.status].label}`}
            />
          ) : null}
        </div>
        <div>
          <h3>{dispute ? 'The student says' : 'Details (private)'}</h3>
          <p style={{ whiteSpace: 'pre-line' }}>{dispute ? dispute.reason : excuse!.description}</p>
        </div>
        {dispute?.attempts && dispute.attempts.length > 0 ? (
          <div>
            <h3>What the system recorded</h3>
            <ul>
              {dispute.attempts.map((a) => (
                <li key={a.receivedAt}>
                  {formatDateTime(a.receivedAt)}: {a.outcome.toLowerCase().replaceAll('_', ' ')}
                  {a.reason ? ` (${a.reason.toLowerCase().replaceAll('_', ' ')})` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {excuse?.classes ? (
          <div>
            <h3>Classes covered</h3>
            <ul>
              {excuse.classes.map((c) => (
                <li key={c.classSessionId}>
                  {c.course?.code ?? 'Class'} · {c.scheduledStart ? formatDateTime(c.scheduledStart) : ''} ·{' '}
                  {c.recordStatus ? RECORD_DISPLAY[c.recordStatus].label : 'not recorded yet'}
                  {c.included === true ? ' · excused' : c.included === false ? ' · not excused' : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.attachments && r.attachments.length > 0 ? (
          <div>
            <h3>Files</h3>
            <div className="row">
              {r.attachments.map((a) => (
                <Button key={a.fileId} size="sm" variant="secondary" onClick={() => void openFile(a.fileId)}>
                  {a.name ?? 'File'} ({Math.ceil(a.sizeBytes / 1024)} KB)
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {r.messages && r.messages.length > 0 ? (
          <div>
            <h3>History</h3>
            <ul>
              {r.messages.map((m) => (
                <li key={`${m.at}-${m.kind}`}>
                  {formatDateTime(m.at)} · {m.kind === 'QUESTION' ? `${m.by} asked` : 'the student replied'}:
                  “{m.body}”
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.decisionNote ? <Alert tone="info">Decision note: {r.decisionNote}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {open ? (
          <div className="row">
            <Button onClick={() => setDialog('approve')}>{dispute ? 'Approve' : 'Excuse classes'}</Button>
            {r.status === 'SUBMITTED' ? (
              <Button variant="secondary" onClick={() => setDialog('ask')}>
                Ask for more information
              </Button>
            ) : null}
            <Button variant="danger" onClick={() => setDialog('reject')}>
              Reject
            </Button>
          </div>
        ) : null}
        <p className="muted">
          {dispute
            ? 'Approving writes a correction with your name, the student’s reason and an audit entry. Nothing changes until you decide.'
            : 'Approving excuses the chosen classes. Lecturers see only “Excused”, never the reason or files.'}
        </p>
      </div>
      {dialog === 'ask' ? (
        <TextDialog
          title="Ask the student"
          label="Your question (sent to the student)"
          submitLabel="Send question"
          min={5}
          onSubmit={(question) => auth.call(`${base}/request-info`, { method: 'POST', body: { question } })}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
      {dialog === 'reject' ? (
        <TextDialog
          title="Reject"
          label="Why (sent to the student)"
          submitLabel="Reject"
          destructive
          min={5}
          onSubmit={(note) => auth.call(`${base}/reject`, { method: 'POST', body: { note } })}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
      {dialog === 'approve' && dispute ? (
        <ApproveDisputeDialog base={base} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog === 'approve' && excuse ? (
        <ApproveExcuseDialog base={base} excuse={excuse} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
    </div>
  );
}

function TextDialog(props: {
  title: string;
  label: string;
  submitLabel: string;
  min: number;
  destructive?: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  return (
    <FormDialog
      open
      title={props.title}
      submitLabel={props.submitLabel}
      destructive={props.destructive}
      validate={() => (text.trim().length < props.min ? `At least ${props.min} characters.` : null)}
      onSubmit={async () => {
        await props.onSubmit(text.trim());
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label={props.label} name="text" multiline value={text} onChange={setText} maxLength={1000} />
    </FormDialog>
  );
}

function ApproveDisputeDialog(props: { base: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [status, setStatus] = useState('PRESENT');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      title="Approve the dispute"
      description="The record changes, with a correction naming you and the student’s reason."
      submitLabel="Approve"
      onSubmit={async () => {
        await auth.call(`${props.base}/approve`, {
          method: 'POST',
          body: { status, ...(note.trim() ? { note: note.trim() } : {}) },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="Change the record to"
        name="status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'PRESENT', label: 'Present' },
          { value: 'LATE', label: 'Late' },
        ]}
      />
      <Field
        label="Note to the student (optional)"
        name="note"
        multiline
        value={note}
        onChange={setNote}
        maxLength={1000}
      />
    </FormDialog>
  );
}

function ApproveExcuseDialog(props: {
  base: string;
  excuse: Excuse;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const classes = props.excuse.classes ?? [];
  const [chosen, setChosen] = useState<Set<string>>(new Set(classes.map((c) => c.classSessionId)));
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      title="Excuse classes"
      description="Absent or rejected records of the chosen classes become Excused. Classes the student attended stay as they are."
      submitLabel={`Excuse ${chosen.size} class${chosen.size === 1 ? '' : 'es'}`}
      validate={() => (chosen.size === 0 ? 'Choose at least one class, or reject the request.' : null)}
      onSubmit={async () => {
        await auth.call(`${props.base}/approve`, {
          method: 'POST',
          body: { classSessionIds: [...chosen], ...(note.trim() ? { note: note.trim() } : {}) },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Classes to excuse</legend>
        {classes.map((c) => (
          <label
            key={c.classSessionId}
            style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 32 }}
          >
            <input
              type="checkbox"
              checked={chosen.has(c.classSessionId)}
              onChange={(e) =>
                setChosen((s) => {
                  const next = new Set(s);
                  if (e.target.checked) next.add(c.classSessionId);
                  else next.delete(c.classSessionId);
                  return next;
                })
              }
            />
            {c.course?.code ?? 'Class'} · {c.scheduledStart ? formatDateTime(c.scheduledStart) : ''}
          </label>
        ))}
      </fieldset>
      <Field
        label="Note to the student (optional)"
        name="note"
        multiline
        value={note}
        onChange={setNote}
        maxLength={1000}
      />
    </FormDialog>
  );
}
