import { ROLE_LABELS, type RoleKey } from '@attendsure/shared';

/** Dates are shown in the institution's time zone (Africa/Accra), never the viewer's device setting. */
const TIME_ZONE = 'Africa/Accra';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export const roleLabel = (role: RoleKey) => ROLE_LABELS[role];

export const STATUS_LABELS = {
  PENDING_ACTIVATION: 'Awaiting activation',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
} as const;
