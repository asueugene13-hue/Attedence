'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { Alert, LoadingState } from '@/components/ui';
import { ApiError, describeError } from '@/lib/api';
import { QrImage, timeOf } from '@/lib/attendance';
import { useAuth } from '@/lib/auth';

interface CurrentCode {
  token: string;
  window: number;
  rotationSeconds: number;
  expiresAt: string;
  serverTime: string;
  closesAt: string;
}

/**
 * The attendance code for a projector (D-19), full screen and without the dashboard around it. The
 * code changes every rotation; this page asks the server for the current one just as it changes. The
 * secret behind it never reaches the browser.
 */
export default function AttendanceCodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status === 'signed-out') router.replace('/login');
  }, [auth.status, router]);
  const code = useQuery({
    queryKey: ['attendance', 'code', id],
    enabled: auth.status === 'signed-in',
    queryFn: () => auth.call<CurrentCode>(`/attendance-sessions/${id}/qr`),
    // Fetch again just after the current code expires (server time decides; allow for a slow clock).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const skew = Date.now() - Date.parse(data.serverTime);
      return Math.min(Math.max(Date.parse(data.expiresAt) + skew - Date.now() + 300, 500), 30_000);
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 409) && count < 3,
  });
  const size = useCodeSize();

  if (auth.status !== 'signed-in' || code.isPending) {
    return (
      <main className="auth-page">
        <LoadingState label="Loading the attendance code…" />
      </main>
    );
  }
  if (code.isError) {
    const closed = code.error instanceof ApiError && code.error.code === 'ATTENDANCE_CLOSED';
    return (
      <main className="auth-page">
        <Alert tone={closed ? 'info' : 'error'}>
          {closed ? 'Attendance is closed for this class.' : describeError(code.error)}
        </Alert>
      </main>
    );
  }
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 16,
        background: '#fff',
        color: '#111',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 28, textAlign: 'center' }}>
        Scan with the AttendSure app to check in
      </h1>
      <QrImage text={code.data.token} size={size} />
      <p style={{ margin: 0, fontSize: 18, textAlign: 'center' }}>
        The code changes every {code.data.rotationSeconds} seconds · attendance closes at{' '}
        {timeOf(code.data.closesAt)}
      </p>
    </main>
  );
}

/** As large as the screen allows, leaving room for the two lines of text. */
function useCodeSize() {
  const [size, setSize] = useState(480);
  useEffect(() => {
    const update = () => setSize(Math.max(200, Math.min(window.innerWidth - 32, window.innerHeight - 200)));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}
