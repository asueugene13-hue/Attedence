'use client';

import Link from 'next/link';
import { type ClassSessionView, classLabel, classTime, STATUS_DISPLAY } from '@/lib/classes';
import { StatusBadge } from './records';

/** A table of classes, each linking to its page. */
export function ClassTable({ sessions, empty }: { sessions: ClassSessionView[]; empty: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Class</th>
            <th scope="col">Lecturer</th>
            <th scope="col">Room</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                {empty}
              </td>
            </tr>
          ) : (
            sessions.map((s) => (
              <tr key={s.id}>
                <td>{classTime(s)}</td>
                <td>
                  <Link href={`/classes/${s.id}`}>{classLabel(s)}</Link>
                  {s.kind !== 'REGULAR' ? (
                    <span className="muted"> · {s.kind === 'REPLACEMENT' ? 'replacement' : 'make-up'}</span>
                  ) : null}
                </td>
                <td>{s.lecturer?.fullName ?? '—'}</td>
                <td>{s.classroom ? `${s.classroom.code} · ${s.classroom.name}` : '—'}</td>
                <td>
                  <StatusBadge tone={STATUS_DISPLAY[s.status].tone} label={STATUS_DISPLAY[s.status].label} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
