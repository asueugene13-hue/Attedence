'use client';

import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react';
import type { UserSummary } from '@/lib/types';
import { STATUS_LABELS } from '@/lib/format';

// Icons: Lucide shapes, 1.75 stroke (design system). Decorative, so hidden from screen readers.
const svg = (path: ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);
export const Icons = {
  check: (s?: number) => svg(<path d="M20 6 9 17l-5-5" />, s),
  x: (s?: number) => svg(<path d="M18 6 6 18M6 6l12 12" />, s),
  clock: (s?: number) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
      s,
    ),
  alert: (s?: number) =>
    svg(
      <>
        <path d="M12 3 2 20h20L12 3z" />
        <path d="M12 10v4M12 17h.01" />
      </>,
      s,
    ),
  info: (s?: number) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>,
      s,
    ),
  ban: (s?: number) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M5.6 5.6l12.8 12.8" />
      </>,
      s,
    ),
};

/**
 * The university's crest and wordmark (supplied by the product owner, docs/brand/), with the product
 * name under them. Plain <img> elements: the files are static SVGs in public/brand.
 */
export function BrandMark() {
  return (
    <div className="brand">
      <img className="brand-crest" src="/brand/knutsford-crest.svg" alt="Knutsford University crest" />
      <div className="brand-name">
        <img className="brand-wordmark" src="/brand/knutsford-wordmark.svg" alt="Knutsford University" />
        <span>AttendSure</span>
      </div>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  block?: boolean;
  busy?: boolean;
  busyLabel?: string;
};

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  busy,
  busyLabel,
  children,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    block ? 'btn-block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? (busyLabel ?? 'Working…') : children}
    </button>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  autoComplete?: string;
  required?: boolean;
  multiline?: boolean;
  inputMode?: 'numeric' | 'email' | 'tel' | 'text';
  maxLength?: number;
  autoFocus?: boolean;
}) {
  const id = useId();
  const describedBy =
    [props.hint ? `${id}-hint` : '', props.error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    name: props.name,
    value: props.value,
    required: props.required,
    maxLength: props.maxLength,
    autoFocus: props.autoFocus,
    'aria-invalid': props.error ? true : undefined,
    'aria-describedby': describedBy,
  };
  return (
    <div className="field" data-invalid={props.error ? 'true' : undefined}>
      <label htmlFor={id}>
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {props.multiline ? (
        <textarea {...common} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={props.type ?? 'text'}
          autoComplete={props.autoComplete}
          inputMode={props.inputMode}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      {props.hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {props.hint}
        </span>
      ) : null}
      {props.error ? (
        <span id={`${id}-error`} className="field-error">
          {props.error}
        </span>
      ) : null}
    </div>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
}) {
  const icon = { info: Icons.info(), success: Icons.check(), warning: Icons.alert(), error: Icons.alert() }[
    tone
  ];
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

/** Every status shows an icon and a word, never colour alone (design system). */
export function UserStatusBadge({ status }: { status: UserSummary['status'] }) {
  const tone = {
    ACTIVE: 'success',
    PENDING_ACTIVATION: 'warning',
    SUSPENDED: 'error',
    DEACTIVATED: 'neutral',
  }[status];
  const icon = {
    ACTIVE: Icons.check(12),
    PENDING_ACTIVATION: Icons.clock(12),
    SUSPENDED: Icons.ban(12),
    DEACTIVATED: Icons.x(12),
  }[status];
  return (
    <span className={`badge badge-${tone}`}>
      {icon}
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}
