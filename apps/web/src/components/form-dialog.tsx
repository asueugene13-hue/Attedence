'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, describeError } from '@/lib/api';
import { Alert, Button } from './ui';

/**
 * A dialog with a form of any fields. `onSubmit` returns nothing on success; a thrown API error is
 * shown in the dialog, including the problems a conflict check reported (blockers and warnings).
 */
export function FormDialog(props: {
  open: boolean;
  title: string;
  description?: string;
  submitLabel: string;
  destructive?: boolean;
  /** Return a message to show instead of submitting (simple checks before calling the API). */
  validate?: () => string | null;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setError(null);
      setProblems([]);
      dialog.showModal();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  }, [props.open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const invalid = props.validate?.() ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      await props.onSubmit();
      props.onClose();
    } catch (err) {
      setError(describeError(err));
      const details = err instanceof ApiError ? (err.details as { blockers?: { message: string }[] }) : null;
      if (details?.blockers) setProblems(details.blockers.map((b) => b.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-label={props.title} onClose={props.onClose}>
      <form className="dialog-body" onSubmit={submit} noValidate>
        <h2>{props.title}</h2>
        {props.description ? <p className="secondary-text">{props.description}</p> : null}
        {props.children}
        {error ? (
          <Alert tone="error">
            {error}
            {problems.length > 1 ? (
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        <div className="row">
          <span className="spacer" />
          <Button type="button" variant="secondary" onClick={props.onClose} disabled={busy}>
            Close
          </Button>
          <Button type="submit" variant={props.destructive ? 'danger' : 'primary'} busy={busy}>
            {props.submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
