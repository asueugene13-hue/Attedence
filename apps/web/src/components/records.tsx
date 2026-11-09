'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { useAuth } from '@/lib/auth';
import type { AcademicYear, Level, Programme } from '@/lib/records';
import { Icons } from './ui';

export function SelectField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={id}
        name={props.name}
        value={props.value}
        required={props.required}
        disabled={props.disabled}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.placeholder !== undefined ? <option value="">{props.placeholder}</option> : null}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';
const TONE_ICON: Record<Tone, ReactNode> = {
  success: Icons.check(12),
  warning: Icons.clock(12),
  error: Icons.alert(12),
  neutral: Icons.x(12),
  info: Icons.info(12),
};

/** A status as an icon plus a word, never colour alone (design system). */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`badge badge-${tone}`}>
      {TONE_ICON[tone]}
      {label}
    </span>
  );
}

/** Small labelled counts, from real data only. */
export function Counts({ items }: { items: { label: string; value: number; tone?: Tone }[] }) {
  return (
    <dl className="row" style={{ gap: 24, margin: 0 }}>
      {items.map((item) => (
        <div key={item.label}>
          <dt className="muted" style={{ fontSize: 12 }}>
            {item.label}
          </dt>
          <dd style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Programmes, levels and academic years (with semesters), as staff entered them. */
export function useAcademicOptions() {
  const auth = useAuth();
  const programmes = useQuery({
    queryKey: ['programmes'],
    queryFn: () => auth.call<Programme[]>('/programmes'),
  });
  const levels = useQuery({ queryKey: ['levels'], queryFn: () => auth.call<Level[]>('/academic-levels') });
  const years = useQuery({
    queryKey: ['years'],
    queryFn: () => auth.call<AcademicYear[]>('/academic-years'),
  });
  return {
    programmes: programmes.data ?? [],
    levels: levels.data ?? [],
    years: years.data ?? [],
    isPending: programmes.isPending || levels.isPending || years.isPending,
    error: programmes.error ?? levels.error ?? years.error,
  };
}
