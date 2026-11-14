'use client';

import { ANNOUNCEMENT_LIMITS } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface Targets {
  kind: 'OFFICIAL' | 'COURSE_REP';
  sections: { id: string; code: string; course: { code: string; title: string }; students: number }[];
  departments: { id: string; code: string; name: string }[];
  faculties: { id: string; code: string; name: string }[];
  institution: boolean;
}
interface Sent {
  id: string;
  kind: 'OFFICIAL' | 'COURSE_REP';
  audience: string;
  title: string;
  body: string;
  sentAt: string;
  status: 'PUBLISHED' | 'HIDDEN';
  hiddenReason: string | null;
  emailed: boolean;
  counts: { recipients: number; read: number; reports: number; emailsSent: number };
  reports?: { reason: string; at: string }[];
}
type Scope = 'SECTION' | 'DEPARTMENT' | 'FACULTY' | 'INSTITUTION';

/**
 * Announcements (Phase 6 step 4): lecturers write to the sections they teach, administrators to
 * sections, departments or faculties in their scope (or everyone). Plain text. Below: what you sent,
 * with delivery and read counts; and for moderators, announcements that were reported.
 */
export default function AnnouncementsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const permissions = auth.me?.permissions ?? [];
  const canSend = permissions.includes('announcements.send_official');
  const canModerate = permissions.includes('announcements.moderate');
  const [view, setView] = useState<'MINE' | 'REPORTED'>('MINE');
  const sent = useQuery({
    queryKey: ['announcements', view],
    queryFn: () => auth.call<{ data: Sent[] }>(`/announcements?view=${view}`),
  });
  const [hiding, setHiding] = useState<Sent | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['announcements'] });

  return (
    <div className="stack">
      <PageHeader title="Announcements" subtitle="Messages to students, shown in the app as plain text." />
      {canSend ? <Compose onSent={refresh} /> : null}
      <div className="row">
        <Button size="sm" variant={view === 'MINE' ? 'primary' : 'secondary'} onClick={() => setView('MINE')}>
          Sent by you
        </Button>
        {canModerate ? (
          <Button
            size="sm"
            variant={view === 'REPORTED' ? 'primary' : 'secondary'}
            onClick={() => setView('REPORTED')}
          >
            Reported
          </Button>
        ) : null}
      </div>
      {sent.isPending ? <LoadingState /> : null}
      {sent.isError ? <Alert tone="error">{describeError(sent.error)}</Alert> : null}
      {sent.data?.data.length === 0 ? (
        <p className="muted">
          {view === 'MINE' ? 'You have not sent any announcements.' : 'Nothing has been reported.'}
        </p>
      ) : null}
      {sent.data?.data.map((a) => (
        <article key={a.id} className="card">
          <div className="card-header">
            <h2>{a.title}</h2>
            <div className="muted">
              {a.kind === 'COURSE_REP' ? 'Course rep' : 'Official'} · {a.audience} ·{' '}
              {formatDateTime(a.sentAt)}
            </div>
          </div>
          <div className="card-body stack-sm">
            <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{a.body}</p>
            <dl className="row" style={{ gap: 24, margin: 0 }}>
              <Count label="Delivered" value={a.counts.recipients} />
              <Count label="Read" value={a.counts.read} />
              {a.emailed ? <Count label="Emailed" value={a.counts.emailsSent} /> : null}
              <Count label="Reports" value={a.counts.reports} />
            </dl>
            {a.status === 'HIDDEN' ? (
              <StatusBadge tone="neutral" label={`Hidden: ${a.hiddenReason ?? ''}`} />
            ) : null}
            {a.reports?.map((r) => (
              <div key={r.at} className="muted">
                Reported {formatDateTime(r.at)}: “{r.reason}”
              </div>
            ))}
            {view === 'REPORTED' && a.status === 'PUBLISHED' ? (
              <div>
                <Button size="sm" variant="danger" onClick={() => setHiding(a)}>
                  Hide
                </Button>
              </div>
            ) : null}
          </div>
        </article>
      ))}
      {hiding ? <HideDialog announcement={hiding} onClose={() => setHiding(null)} onDone={refresh} /> : null}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="muted" style={{ fontSize: 12 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{value}</dd>
    </div>
  );
}

function Compose({ onSent }: { onSent: () => Promise<unknown> }) {
  const auth = useAuth();
  const targets = useQuery({
    queryKey: ['announcements', 'targets'],
    queryFn: () => auth.call<Targets>('/announcements/targets'),
  });
  const [scope, setScope] = useState<Scope>('SECTION');
  const [sections, setSections] = useState<Set<string>>(new Set());
  const [departmentId, setDepartmentId] = useState('');
  const [facultyId, setFacultyId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const t = targets.data;
  if (targets.isPending) return <LoadingState />;
  if (targets.isError) return <Alert tone="error">{describeError(targets.error)}</Alert>;
  if (!t) return null;
  const scopes: { value: Scope; label: string }[] = [
    ...(t.sections.length ? [{ value: 'SECTION' as const, label: 'Sections you teach' }] : []),
    ...(t.departments.length ? [{ value: 'DEPARTMENT' as const, label: 'A department' }] : []),
    ...(t.faculties.length ? [{ value: 'FACULTY' as const, label: 'A faculty' }] : []),
    ...(t.institution ? [{ value: 'INSTITUTION' as const, label: 'All students' }] : []),
  ];
  if (scopes.length === 0)
    return <Alert tone="info">You have no class groups or areas to send announcements to.</Alert>;
  const current = scopes.some((s) => s.value === scope) ? scope : scopes[0]!.value;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await auth.call<{ counts: { recipients: number } }>('/announcements', {
        method: 'POST',
        body: {
          scope: current,
          ...(current === 'SECTION' ? { sectionIds: [...sections] } : {}),
          ...(current === 'DEPARTMENT' ? { departmentId } : {}),
          ...(current === 'FACULTY' ? { facultyId } : {}),
          title: title.trim(),
          body: body.trim(),
          email,
        },
      });
      setMessage({ tone: 'success', text: `Sent to ${result.counts.recipients} students.` });
      setTitle('');
      setBody('');
      setSections(new Set());
      await onSent();
    } catch (e) {
      setMessage({ tone: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  const recipients = t.sections.filter((s) => sections.has(s.id)).reduce((n, s) => n + s.students, 0);
  const ready =
    title.trim().length >= 3 &&
    body.trim().length > 0 &&
    (current !== 'SECTION' || sections.size > 0) &&
    (current !== 'DEPARTMENT' || departmentId) &&
    (current !== 'FACULTY' || facultyId);
  return (
    <form className="card" onSubmit={(e) => void send(e)} aria-label="Write an announcement">
      <div className="card-header">
        <h2>Write an announcement</h2>
      </div>
      <div className="card-body stack">
        {scopes.length > 1 ? (
          <SelectField
            label="Send to"
            name="scope"
            value={current}
            onChange={(v) => setScope(v as Scope)}
            options={scopes}
          />
        ) : null}
        {current === 'SECTION' ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Sections</legend>
            {t.sections.map((s) => (
              <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 32 }}>
                <input
                  type="checkbox"
                  checked={sections.has(s.id)}
                  onChange={(e) =>
                    setSections((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    })
                  }
                />
                {s.course.code} · {s.code} · {s.course.title}{' '}
                <span className="muted">· {s.students} students</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {current === 'DEPARTMENT' ? (
          <SelectField
            label="Department"
            name="department"
            value={departmentId}
            onChange={setDepartmentId}
            placeholder="Choose a department"
            options={t.departments.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))}
          />
        ) : null}
        {current === 'FACULTY' ? (
          <SelectField
            label="Faculty"
            name="faculty"
            value={facultyId}
            onChange={setFacultyId}
            placeholder="Choose a faculty"
            options={t.faculties.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
          />
        ) : null}
        <Field
          label="Title"
          name="title"
          value={title}
          onChange={setTitle}
          maxLength={ANNOUNCEMENT_LIMITS.titleMax}
          required
        />
        <Field
          label="Message"
          name="body"
          multiline
          value={body}
          onChange={setBody}
          maxLength={ANNOUNCEMENT_LIMITS.bodyMax}
          hint={`Plain text. Links are shown as text, not clickable. ${body.length} / ${ANNOUNCEMENT_LIMITS.bodyMax}`}
          required
        />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
          Also email it to students who get announcement emails
        </label>
        {current === 'SECTION' && sections.size > 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {recipients} students will see this in the app. It is labelled “Official”.
          </p>
        ) : null}
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <div>
          <Button type="submit" busy={busy} disabled={!ready}>
            Send announcement
          </Button>
        </div>
      </div>
    </form>
  );
}

function HideDialog(props: { announcement: Sent; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      destructive
      title="Hide this announcement"
      description="Students no longer see it. It is kept, with your reason, for the record."
      submitLabel="Hide"
      validate={() => (reason.trim().length < 5 ? 'Say why, at least 5 characters.' : null)}
      onSubmit={async () => {
        await auth.call(`/announcements/${props.announcement.id}/hide`, {
          method: 'POST',
          body: { reason: reason.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label="Why" name="reason" multiline value={reason} onChange={setReason} maxLength={500} />
    </FormDialog>
  );
}
