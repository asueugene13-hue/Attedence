'use client';

import { RECURRENCES } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { use, useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { ReasonDialog } from '@/components/reason-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TIMETABLE_STATUS, type TimetableSummary } from '@/lib/classes';
import type { Offering } from '@/lib/records';

interface Entry {
  id: string;
  version: number;
  isCancelled: boolean;
  sections: { id: string; code: string; course: { code: string; title: string } }[];
  lecturer: { id: string; fullName: string } | null;
  classroom: { id: string; code: string; name: string; capacity: number | null } | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: (typeof RECURRENCES)[number];
  selectedWeeks: number[];
  effectiveFrom: string;
  effectiveTo: string;
  exceptions: { id: string; date: string; reason: string }[];
  label: string;
}
type Timetable = TimetableSummary & {
  semester: { id: string; name: string; startDate: string; endDate: string };
  entries: Entry[];
};
interface Conflicts {
  blocking: { kind: string; message: string }[];
  warnings: { kind: string; message: string }[];
  canPublish: boolean;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const RECURRENCE_LABELS: Record<(typeof RECURRENCES)[number], string> = {
  WEEKLY: 'Every week',
  EVERY_OTHER_WEEK: 'Every other week',
  SELECTED_WEEKS: 'Selected teaching weeks',
  ONCE: 'Once (a single date)',
};

/** One timetable version: its entries, the clash check, and publishing. Only a draft can be edited. */
export default function TimetablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const timetable = useQuery({
    queryKey: ['timetable', id],
    queryFn: () => auth.call<Timetable>(`/timetables/${id}`),
  });
  const isDraft = timetable.data?.status === 'DRAFT';
  const canManage = auth.can('timetables.manage');
  const conflicts = useQuery({
    queryKey: ['timetable', id, 'conflicts'],
    enabled: Boolean(isDraft && canManage),
    queryFn: () => auth.call<Conflicts>(`/timetables/${id}/conflicts`),
  });
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<Entry | null>(null);
  const [skipping, setSkipping] = useState<Entry | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['timetable', id] }),
      queryClient.invalidateQueries({ queryKey: ['timetables'] }),
    ]);

  if (timetable.isPending) return <LoadingState />;
  if (timetable.isError) return <Alert tone="error">{describeError(timetable.error)}</Alert>;
  const t = timetable.data;

  return (
    <div className="stack">
      <PageHeader
        title={t.name}
        subtitle={`${t.semester.name} · version ${t.version} · ${t.semester.startDate} to ${t.semester.endDate}`}
        actions={
          isDraft && canManage ? (
            <div className="row">
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add a class
              </Button>
              {auth.can('timetables.publish') ? (
                <Button disabled={!conflicts.data?.canPublish} onClick={() => setPublishing(true)}>
                  Publish
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      <div className="row">
        <StatusBadge tone={TIMETABLE_STATUS[t.status].tone} label={TIMETABLE_STATUS[t.status].label} />
        {t.status === 'PUBLISHED' ? (
          <span className="muted">
            {t.sessionsGeneratedAt ? 'Classes have been created from it.' : 'Classes are being created…'} To
            change it, create a new draft from the timetable list.
          </span>
        ) : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {isDraft && canManage ? (
        <section className="card" aria-labelledby="clash-heading">
          <div className="card-header">
            <h2 id="clash-heading">Clash check</h2>
          </div>
          <div className="card-body stack-sm">
            {conflicts.isPending ? <LoadingState label="Checking…" /> : null}
            {conflicts.isError ? <Alert tone="error">{describeError(conflicts.error)}</Alert> : null}
            {conflicts.data ? (
              <>
                {conflicts.data.blocking.length === 0 ? (
                  <Alert tone="success">No room, lecturer or section is booked twice.</Alert>
                ) : (
                  conflicts.data.blocking.map((c) => (
                    <Alert key={c.message} tone="error">
                      {c.message}
                    </Alert>
                  ))
                )}
                {conflicts.data.warnings.map((w) => (
                  <Alert key={w.message} tone="warning">
                    {w.message}
                  </Alert>
                ))}
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">When</th>
              <th scope="col">Lecturer</th>
              <th scope="col">Room</th>
              <th scope="col">Skipped dates</th>
              {isDraft && canManage ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {t.entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No classes yet.
                </td>
              </tr>
            ) : (
              t.entries.map((e) => (
                <tr key={e.id} style={e.isCancelled ? { opacity: 0.6 } : undefined}>
                  <td>
                    {e.sections.map((s) => `${s.course.code} ${s.code}`).join(' + ')}
                    {e.isCancelled ? <StatusBadge tone="neutral" label="Removed" /> : null}
                  </td>
                  <td>
                    {e.recurrence === 'ONCE' ? e.effectiveFrom : DAYS[e.dayOfWeek - 1]} {e.startTime}–
                    {e.endTime}
                    <div className="muted">
                      {RECURRENCE_LABELS[e.recurrence]}
                      {e.recurrence === 'SELECTED_WEEKS' ? `: weeks ${e.selectedWeeks.join(', ')}` : ''}
                      {e.recurrence !== 'ONCE' ? ` · ${e.effectiveFrom} to ${e.effectiveTo}` : ''}
                    </div>
                  </td>
                  <td>{e.lecturer?.fullName ?? '—'}</td>
                  <td>{e.classroom ? `${e.classroom.code} · ${e.classroom.name}` : '—'}</td>
                  <td>{e.exceptions.map((x) => `${x.date} (${x.reason})`).join('; ') || '—'}</td>
                  {isDraft && canManage ? (
                    <td>
                      {!e.isCancelled ? (
                        <div className="row">
                          <Button size="sm" variant="ghost" onClick={() => setSkipping(e)}>
                            Skip a date
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCancelling(e)}>
                            Remove
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {adding ? <EntryDialog timetable={t} onClose={() => setAdding(false)} onDone={refresh} /> : null}
      <ReasonDialog
        open={Boolean(cancelling)}
        title="Remove this class from the timetable"
        description={cancelling ? `${cancelling.label}. It stays in the record, marked removed.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/timetable-entries/${cancelling!.id}/cancel`, {
            method: 'POST',
            body: { reason },
          });
          await refresh();
        }}
        onClose={() => setCancelling(null)}
      />
      {skipping ? <SkipDialog entry={skipping} onClose={() => setSkipping(null)} onDone={refresh} /> : null}
      <ReasonDialog
        open={publishing}
        title="Publish this timetable"
        description="Classes are created for every meeting, and the previous published version is replaced. Future classes carry over where nothing changed."
        confirmLabel="Publish"
        onConfirm={async (reason) => {
          await auth.call(`/timetables/${id}/publish`, { method: 'POST', body: { reason } });
          setNotice('Published. Classes are being created in the background.');
          await refresh();
        }}
        onClose={() => setPublishing(false)}
      />
    </div>
  );
}

interface Lecturer {
  id: string;
  staffNumber: string;
  user: { fullName: string };
}

function EntryDialog(props: { timetable: Timetable; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const offerings = useQuery({
    queryKey: ['offerings', props.timetable.semesterId],
    queryFn: () => auth.call<Offering[]>(`/course-offerings?semesterId=${props.timetable.semesterId}`),
  });
  const lecturers = useQuery({ queryKey: ['lecturers'], queryFn: () => auth.call<Lecturer[]>('/lecturers') });
  const rooms = useQuery({
    queryKey: ['classrooms'],
    queryFn: () => auth.call<{ id: string; code: string; name: string }[]>('/classrooms'),
  });
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [lecturerId, setLecturerId] = useState('');
  const [classroomId, setClassroomId] = useState('');
  const [recurrence, setRecurrence] = useState<string>('WEEKLY');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [weeks, setWeeks] = useState('');
  const sections = (offerings.data ?? []).flatMap((o) =>
    o.sections.map((s) => ({ id: s.id, label: `${o.course.code} ${o.course.title} · section ${s.code}` })),
  );

  return (
    <FormDialog
      open
      title="Add a class"
      description="The lecturer must be assigned to every section chosen. Dates default to the whole semester."
      submitLabel="Add"
      validate={() => {
        if (sectionIds.length === 0) return 'Choose at least one section.';
        if (!lecturerId || !classroomId) return 'Choose the lecturer and the room.';
        if (!startTime || !endTime) return 'Give the start and end times.';
        if (recurrence === 'ONCE' && !date) return 'Choose the date.';
        if (recurrence === 'SELECTED_WEEKS' && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(weeks))
          return 'List the teaching weeks, for example 1, 3, 5.';
        return null;
      }}
      onSubmit={async () => {
        await auth.call(`/timetables/${props.timetable.id}/entries`, {
          method: 'POST',
          body: {
            sectionIds,
            lecturerId,
            classroomId,
            recurrence,
            startTime,
            endTime,
            ...(recurrence === 'ONCE' ? { date } : { dayOfWeek: Number(dayOfWeek) }),
            ...(recurrence === 'SELECTED_WEEKS'
              ? { selectedWeeks: weeks.split(',').map((w) => Number(w.trim())) }
              : {}),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <fieldset className="stack-sm">
        <legend>Sections</legend>
        {offerings.isPending ? <LoadingState /> : null}
        {sections.length === 0 && !offerings.isPending ? (
          <p className="muted">No open course sections in this semester.</p>
        ) : null}
        {sections.map((s) => (
          <label key={s.id} className="checkbox">
            <input
              type="checkbox"
              checked={sectionIds.includes(s.id)}
              onChange={(e) =>
                setSectionIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))
              }
            />{' '}
            {s.label}
          </label>
        ))}
      </fieldset>
      <SelectField
        label="Lecturer"
        name="lecturerId"
        value={lecturerId}
        onChange={setLecturerId}
        placeholder="Choose a lecturer"
        options={(lecturers.data ?? []).map((l) => ({
          value: l.id,
          label: `${l.user.fullName} (${l.staffNumber})`,
        }))}
      />
      <SelectField
        label="Room"
        name="classroomId"
        value={classroomId}
        onChange={setClassroomId}
        placeholder="Choose a room"
        options={(rooms.data ?? []).map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
      />
      <SelectField
        label="Repeats"
        name="recurrence"
        value={recurrence}
        onChange={setRecurrence}
        options={RECURRENCES.map((r) => ({ value: r, label: RECURRENCE_LABELS[r] }))}
      />
      {recurrence === 'ONCE' ? (
        <Field label="Date" name="date" type="date" value={date} onChange={setDate} />
      ) : (
        <SelectField
          label="Day"
          name="dayOfWeek"
          value={dayOfWeek}
          onChange={setDayOfWeek}
          options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
        />
      )}
      {recurrence === 'SELECTED_WEEKS' ? (
        <Field
          label="Teaching weeks (week 1 = the semester’s first week)"
          name="weeks"
          value={weeks}
          onChange={setWeeks}
        />
      ) : null}
      <div className="row">
        <Field label="Starts" name="startTime" type="time" value={startTime} onChange={setStartTime} />
        <Field label="Ends" name="endTime" type="time" value={endTime} onChange={setEndTime} />
      </div>
    </FormDialog>
  );
}

function SkipDialog(props: { entry: Entry; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title="Skip one date"
      description={`${props.entry.label}. The class will not meet on that date.`}
      submitLabel="Skip date"
      validate={() =>
        !date
          ? 'Choose the date.'
          : reason.trim().length < 5
            ? 'Explain briefly, at least 5 characters.'
            : null
      }
      onSubmit={async () => {
        await auth.call(`/timetable-entries/${props.entry.id}/exceptions`, {
          method: 'POST',
          body: { date, reason: reason.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label="Date" name="date" type="date" value={date} onChange={setDate} />
      <Field label="Reason" name="reason" multiline value={reason} onChange={setReason} maxLength={500} />
    </FormDialog>
  );
}
