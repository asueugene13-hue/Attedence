'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge, useAcademicOptions } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { STUDENT_STATUS_LABELS, type StudentView, studentTone } from '@/lib/records';
import type { Page } from '@/lib/types';

export default function StudentsPage() {
  return (
    <PermissionGate permission="students.read_full">
      <StudentsList />
    </PermissionGate>
  );
}

function StudentsList() {
  const auth = useAuth();
  const academic = useAcademicOptions();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ q: '', programmeId: '', levelId: '', status: '' });

  const query = useInfiniteQuery({
    queryKey: ['students', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      if (pageParam) params.set('cursor', pageParam);
      return auth.call<Page<StudentView>>(`/students?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const students = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Students"
        subtitle="Student records. Faculty and department follow from each student's programme."
        actions={
          <>
            {auth.can('students.import') ? (
              <Link className="btn btn-secondary" href="/imports?type=students">
                Bulk import
              </Link>
            ) : null}
            {auth.can('students.create') ? (
              <Link className="btn btn-primary" href="/students/new">
                Register student
              </Link>
            ) : null}
          </>
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
          <label htmlFor="student-search">Search Student ID, name or email</label>
          <input id="student-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <SelectField
          label="Programme"
          name="programmeId"
          value={filters.programmeId}
          onChange={(programmeId) => setFilters((f) => ({ ...f, programmeId }))}
          placeholder="Any programme"
          options={academic.programmes.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
        />
        <SelectField
          label="Level"
          name="levelId"
          value={filters.levelId}
          onChange={(levelId) => setFilters((f) => ({ ...f, levelId }))}
          placeholder="Any level"
          options={academic.levels.map((l) => ({ value: l.id, label: l.name }))}
        />
        <SelectField
          label="Status"
          name="status"
          value={filters.status}
          onChange={(status) => setFilters((f) => ({ ...f, status }))}
          placeholder="Any status"
          options={Object.entries(STUDENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
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
                  <th scope="col">Student ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Programme</th>
                  <th scope="col">Level</th>
                  <th scope="col">Status</th>
                  <th scope="col">Record</th>
                </tr>
              </thead>
              <tbody>
                {students.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No students match.
                    </td>
                  </tr>
                ) : (
                  students.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/students/${s.id}`}>{s.studentNumber}</Link>
                      </td>
                      <td>{s.fullName}</td>
                      <td className="secondary-text">{s.programme.code}</td>
                      <td className="secondary-text">{s.level.name}</td>
                      <td>
                        <StatusBadge tone={studentTone(s.status)} label={STUDENT_STATUS_LABELS[s.status]} />
                      </td>
                      <td>
                        {s.verifiedAt ? (
                          <StatusBadge tone="success" label="Verified" />
                        ) : (
                          <StatusBadge tone="warning" label="Not verified" />
                        )}
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
