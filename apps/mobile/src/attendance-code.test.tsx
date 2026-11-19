import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from './lib/api';
import { AttendanceCodeScreen } from './screens/AttendanceCodeScreen';

// The lecturer's attendance code keeps the phone's screen on while it is shown, and lets it go when
// attendance closes (KNOWN_LIMITATIONS 84). The API is a fake; obviously fake data.
const mockAwake = new Set<string>();
jest.mock('expo-keep-awake', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useKeepAwake: (tag: string) => {
      useEffect(() => {
        mockAwake.add(tag);
        return () => void mockAwake.delete(tag);
      }, [tag]);
    },
  };
});
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { attendanceSessionId: 'as-1' } }),
}));
const mockCall = jest.fn();
jest.mock('./lib/auth', () => ({ useAuth: () => ({ call: mockCall }) }));

function code(expiresInMs: number) {
  const now = Date.now();
  return {
    token: 'ASQR-FAKE-TEST-TOKEN',
    rotationSeconds: 15,
    expiresAt: new Date(now + expiresInMs).toISOString(),
    serverTime: new Date(now).toISOString(),
    closesAt: new Date(now + 10 * 60_000).toISOString(),
  };
}

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <AttendanceCodeScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockAwake.clear();
  mockCall.mockReset();
});

test('the screen stays on while the code is shown, and is let go when attendance closes', async () => {
  // The first code expires at once, so the screen asks again after half a second; by then attendance has closed.
  mockCall
    .mockResolvedValueOnce(code(0))
    .mockRejectedValue(new ApiError(409, 'ATTENDANCE_CLOSED', 'Attendance is closed.'));
  await show();

  expect(await screen.findByLabelText('Attendance code')).toBeTruthy();
  expect(mockCall).toHaveBeenCalledWith('/attendance-sessions/as-1/qr');
  expect([...mockAwake]).toEqual(['attendsure-attendance-code']);

  expect(await screen.findByText('Attendance is closed for this class.', {}, { timeout: 3000 })).toBeTruthy();
  expect(mockAwake.size).toBe(0);
});

test('the screen is not kept on while the code is still loading or cannot be shown', async () => {
  mockCall.mockRejectedValue(new ApiError(409, 'ATTENDANCE_NOT_OPEN', 'Attendance has not opened yet.'));
  await show();

  expect(mockAwake.size).toBe(0);
  await waitFor(() => expect(screen.queryByText('Loading the code…')).toBeNull(), { timeout: 3000 });
  expect(screen.queryByLabelText('Attendance code')).toBeNull();
  expect(mockAwake.size).toBe(0);
});
