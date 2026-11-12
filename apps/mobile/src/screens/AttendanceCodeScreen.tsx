import { type RouteProp, useRoute } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { BodyText, Notice } from '../components/ui';
import { ApiError, describeError } from '../lib/api';
import { qrGrid } from '../lib/attendance';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';

interface CurrentCode {
  token: string;
  rotationSeconds: number;
  expiresAt: string;
  serverTime: string;
  closesAt: string;
}

/** The attendance code on the lecturer's phone, refreshed just as it changes (secret stays on the server). */
export function AttendanceCodeScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'AttendanceCode'>>();
  const { call } = useAuth();
  const { width } = useWindowDimensions();
  const code = useQuery({
    queryKey: ['attendance-code', route.params.attendanceSessionId],
    queryFn: () => call<CurrentCode>(`/attendance-sessions/${route.params.attendanceSessionId}/qr`),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const skew = Date.now() - Date.parse(data.serverTime);
      return Math.min(Math.max(Date.parse(data.expiresAt) + skew - Date.now() + 300, 500), 30_000);
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 409) && count < 3,
  });
  const grid = useMemo(() => (code.data ? qrGrid(code.data.token) : null), [code.data]);
  const size = Math.min(width - 32, 420);

  if (code.isError) {
    const closed = code.error instanceof ApiError && code.error.code === 'ATTENDANCE_CLOSED';
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 16, backgroundColor: '#fff' }}>
        <Notice tone={closed ? 'info' : 'error'}>
          {closed ? 'Attendance is closed for this class.' : describeError(code.error)}
        </Notice>
      </View>
    );
  }
  if (!code.data || !grid) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <BodyText muted>Loading the code…</BodyText>
      </View>
    );
  }
  const quiet = 4;
  const total = grid.size + quiet * 2;
  let path = '';
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) if (grid.dark(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 16,
        backgroundColor: '#fff',
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: '600', color: '#111', textAlign: 'center' }}>
        Scan with the AttendSure app
      </Text>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} accessibilityLabel="Attendance code">
        <Path d={path} fill="#000" />
      </Svg>
      <Text style={{ fontSize: 15, color: '#333', textAlign: 'center' }}>
        {`Changes every ${code.data.rotationSeconds} seconds · closes at ${new Date(code.data.closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
      </Text>
    </View>
  );
}
