'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { SelectField, StatusBadge } from './records';
import { Alert, Button, Field, LoadingState } from './ui';

export type FormValues = Record<string, string | boolean>;

export interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Shown only when adding (for example the parent, which cannot change later). */
  createOnly?: boolean;
  /** Shown only when editing (for example a status that starts at its default). */
  editOnly?: boolean;
  maxLength?: number;
}

export interface EntityManagerProps<T extends { id: string; isActive?: boolean }> {
  title: string;
  /** Singular, lower case: "faculty". */
  noun: string;
  description?: ReactNode;
  /** Path to list from; `includeInactive=true` is added when the toggle is on. */
  listPath: string;
  queryKey: readonly unknown[];
  /** Holding this permission shows Add, Edit and Deactivate. The API still checks every request. */
  managePermission: string;
  columns: { header: string; cell: (row: T) => ReactNode }[];
  fields: FieldSpec[];
  emptyForm: FormValues;
  toForm: (row: T) => FormValues;
  toBody: (form: FormValues, mode: 'create' | 'edit') => object;
  createPath: string;
  updatePath: (row: T) => string;
  /** Records are deactivated, never deleted (PATCH { isActive }). */
  deactivatable?: boolean;
  rowActions?: (row: T) => ReactNode;
  /** Shown above the table (for example a filter). */
  toolbar?: ReactNode;
  /** Other lists to refresh after a change (for example the parent's child counts). */
  alsoInvalidate?: readonly unknown[][];
}

/**
 * A list of one kind of record with Add, Edit and Deactivate, as used by the setup screens.
 * Every change is checked and audited by the API; this only collects input and shows results.
 */
export function EntityManager<T extends { id: string; isActive?: boolean }>(props: EntityManagerProps<T>) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; row: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = auth.can(props.managePermission);
  const separator = props.listPath.includes('?') ? '&' : '?';
  const path =
    props.deactivatable && includeInactive
      ? `${props.listPath}${separator}includeInactive=true`
      : props.listPath;

  const query = useQuery({
    queryKey: [...props.queryKey, includeInactive],
    queryFn: () => auth.call<T[]>(path),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: props.queryKey }),
      ...(props.alsoInvalidate ?? []).map((key) => queryClient.invalidateQueries({ queryKey: key })),
    ]);

  async function setActive(row: T, isActive: boolean) {
    setError(null);
    try {
      await auth.call(props.updatePath(row), { method: 'PATCH', body: { isActive } });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const rows = query.data ?? [];
  return (
    <section className="card" aria-labelledby={`${props.noun}-heading`}>
      <div className="card-header row">
        <h2 id={`${props.noun}-heading`}>{props.title}</h2>
        <span className="spacer" />
        {props.deactivatable ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            Show inactive
          </label>
        ) : null}
        {canManage ? (
          <Button size="sm" onClick={() => setEditing({ mode: 'create' })}>
            Add {props.noun}
          </Button>
        ) : null}
      </div>
      {props.description || props.toolbar ? (
        <div className="card-body stack-sm">
          {props.description ? <div className="secondary-text">{props.description}</div> : null}
          {props.toolbar}
        </div>
      ) : null}
      {query.isError ? <Alert tone="error">{describeError(query.error)}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {query.isPending ? (
        <div className="card-body">
          <LoadingState />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {props.columns.map((c) => (
                  <th key={c.header} scope="col">
                    {c.header}
                  </th>
                ))}
                {props.deactivatable ? <th scope="col">Status</th> : null}
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={props.columns.length + 2} className="muted">
                    None yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    {props.columns.map((c) => (
                      <td key={c.header}>{c.cell(row)}</td>
                    ))}
                    {props.deactivatable ? (
                      <td>
                        {row.isActive ? (
                          <StatusBadge tone="success" label="Active" />
                        ) : (
                          <StatusBadge tone="neutral" label="Inactive" />
                        )}
                      </td>
                    ) : null}
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        {props.rowActions?.(row)}
                        {canManage ? (
                          <Button variant="ghost" size="sm" onClick={() => setEditing({ mode: 'edit', row })}>
                            Edit
                          </Button>
                        ) : null}
                        {canManage && props.deactivatable ? (
                          <Button variant="ghost" size="sm" onClick={() => setActive(row, !row.isActive)}>
                            {row.isActive ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      <EntityDialog
        title={editing?.mode === 'edit' ? `Edit ${props.noun}` : `Add ${props.noun}`}
        open={editing !== null}
        fields={props.fields.filter((f) => (editing?.mode === 'create' ? !f.editOnly : !f.createOnly))}
        initial={editing?.mode === 'edit' ? props.toForm(editing.row) : props.emptyForm}
        onSubmit={async (form) => {
          if (!editing) return;
          const body = props.toBody(form, editing.mode);
          if (editing.mode === 'create') await auth.call(props.createPath, { method: 'POST', body });
          else await auth.call(props.updatePath(editing.row), { method: 'PATCH', body });
          await refresh();
        }}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

/** A form in a modal dialog. Shows the API's field errors next to the fields. */
export function EntityDialog(props: {
  title: string;
  open: boolean;
  fields: FieldSpec[];
  initial: FormValues;
  onSubmit: (form: FormValues) => Promise<void>;
  onClose: () => void;
  submitLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormValues>(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setForm(props.initial);
      setError(null);
      setFieldErrors({});
      dialog.showModal();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset the form only when the dialog opens
  }, [props.open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await props.onSubmit(form);
      props.onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.length > 0) {
        setFieldErrors(Object.fromEntries(err.fieldErrors.map((e) => [e.field ?? '', e.message])));
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string) => (value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <dialog ref={ref} className="dialog" aria-label={props.title} onClose={props.onClose}>
      <form className="dialog-body" onSubmit={submit} noValidate>
        <h2>{props.title}</h2>
        {props.fields.map((f) =>
          f.type === 'select' ? (
            <SelectField
              key={f.key}
              label={f.label}
              name={f.key}
              required={f.required}
              hint={f.hint}
              value={String(form[f.key] ?? '')}
              onChange={set(f.key)}
              placeholder={f.required ? 'Choose…' : 'None'}
              options={f.options ?? []}
            />
          ) : f.type === 'checkbox' ? (
            <label key={f.key} className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(form[f.key])}
                onChange={(e) => set(f.key)(e.target.checked)}
              />
              {f.label}
            </label>
          ) : (
            <Field
              key={f.key}
              label={f.label}
              name={f.key}
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              inputMode={f.type === 'number' ? 'numeric' : undefined}
              required={f.required}
              hint={f.hint}
              maxLength={f.maxLength}
              value={String(form[f.key] ?? '')}
              onChange={set(f.key)}
              error={fieldErrors[f.key]}
            />
          ),
        )}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <span className="spacer" />
          <Button type="button" variant="secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {props.submitLabel ?? 'Save'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** Form helpers: empty text means "not given" (create) or "clear it" (edit, where the API allows null). */
export const text = (v: string | boolean | undefined) =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
export const num = (v: string | boolean | undefined) =>
  typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined;
export const orNull = <V,>(value: V | undefined, mode: 'create' | 'edit') =>
  value === undefined ? (mode === 'edit' ? null : undefined) : value;
