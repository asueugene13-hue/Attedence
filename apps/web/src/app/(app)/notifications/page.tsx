'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface NotificationView {
  id: string;
  category: string;
  title: string;
  body: string;
  data: { path?: string } | null;
  priority: 'NORMAL' | 'HIGH' | 'CRITICAL';
  readAt: string | null;
  createdAt: string;
}
interface Preference {
  category: string;
  label: string;
  mandatory: boolean;
  channels: { channel: 'EMAIL' | 'PUSH'; available: boolean; enabled: boolean }[];
}

/** The signed-in person's notifications, and which ones also come by email. */
export default function NotificationsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () =>
      auth.call<{ data: NotificationView[] }>(`/me/notifications?limit=100&unread=${unreadOnly}`),
  });
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => auth.call<{ data: Preference[] }>('/me/notification-preferences'),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      queryClient.invalidateQueries({ queryKey: ['unread-count'] }),
    ]);

  async function act(path: string) {
    setError(null);
    try {
      await auth.call(path, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function toggle(category: string, channel: 'EMAIL' | 'PUSH', enabled: boolean) {
    setError(null);
    try {
      await auth.call('/me/notification-preferences', {
        method: 'PUT',
        body: { category, channel, enabled },
      });
      await queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Notifications"
        subtitle="Messages about your classes. Cancellations, moves and room changes also come by email."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void act('/me/notifications/read-all')}>
            Mark all as read
          </Button>
        }
      />
      <label className="checkbox">
        <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />{' '}
        Unread only
      </label>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {list.isPending ? <LoadingState /> : null}
      {list.isError ? <Alert tone="error">{describeError(list.error)}</Alert> : null}
      {list.data?.data.length === 0 ? <p className="muted">No notifications.</p> : null}
      <ul className="stack-sm" aria-label="Notifications">
        {list.data?.data.map((n) => (
          <li key={n.id} className="card">
            <div className="card-body stack-sm">
              <div className="row">
                {!n.readAt ? <StatusBadge tone="info" label="New" /> : null}
                {n.priority !== 'NORMAL' ? (
                  <StatusBadge
                    tone={n.priority === 'CRITICAL' ? 'error' : 'warning'}
                    label={n.priority === 'CRITICAL' ? 'Important' : 'Action needed'}
                  />
                ) : null}
                <strong>{n.title}</strong>
                <span className="spacer" />
                <span className="muted">{formatDateTime(n.createdAt)}</span>
              </div>
              <p>{n.body}</p>
              <div className="row">
                {n.data?.path ? (
                  <Link
                    href={n.data.path}
                    className="btn btn-secondary btn-sm"
                    onClick={() => (!n.readAt ? void act(`/me/notifications/${n.id}/read`) : undefined)}
                  >
                    Open
                  </Link>
                ) : null}
                {!n.readAt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(`/me/notifications/${n.id}/read`)}
                  >
                    Mark as read
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <section className="card" aria-labelledby="prefs-heading">
        <div className="card-header">
          <h2 id="prefs-heading">Email and push</h2>
        </div>
        <div className="card-body stack-sm">
          <p className="secondary-text">
            Every notification appears here. Choose which also come by email. Push notifications to phones are
            not switched on yet. Messages about cancelled, moved or restored classes cannot be turned off.
          </p>
          {prefs.isError ? <Alert tone="error">{describeError(prefs.error)}</Alert> : null}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Message</th>
                  <th scope="col">Email</th>
                </tr>
              </thead>
              <tbody>
                {prefs.data?.data.map((p) => {
                  const email = p.channels.find((c) => c.channel === 'EMAIL')!;
                  return (
                    <tr key={p.category}>
                      <td>{p.label}</td>
                      <td>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={email.enabled}
                            disabled={p.mandatory}
                            aria-label={`Email: ${p.label}`}
                            onChange={(e) => void toggle(p.category, 'EMAIL', e.target.checked)}
                          />
                          {p.mandatory ? ' Always' : ''}
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
