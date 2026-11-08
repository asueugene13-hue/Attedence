'use client';

import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/lib/api';
import { Alert, Button, Field } from './ui';

export const MIN_REASON_LENGTH = 5;

/**
 * Confirms a sensitive action and collects the reason that goes into the audit log
 * (suspensions, role changes, permission changes, two-step resets).
 */
export function ReasonDialog(props: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setReason('');
      setError(null);
      setTouched(false);
      dialog.showModal();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  }, [props.open]);

  const tooShort = reason.trim().length < MIN_REASON_LENGTH;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (tooShort) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      props.onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="reason-dialog-title" onClose={props.onClose}>
      <form className="dialog-body" onSubmit={submit} noValidate>
        <h2 id="reason-dialog-title">{props.title}</h2>
        <p className="secondary-text">{props.description}</p>
        <Field
          label="Reason (recorded in the audit log)"
          name="reason"
          multiline
          required
          value={reason}
          onChange={setReason}
          maxLength={500}
          error={
            touched && tooShort ? `Explain briefly, at least ${MIN_REASON_LENGTH} characters.` : undefined
          }
          autoFocus
        />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <span className="spacer" />
          <Button type="button" variant="secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={props.destructive ? 'danger' : 'primary'} busy={busy}>
            {props.confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
