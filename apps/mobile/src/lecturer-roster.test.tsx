import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LecturerAttendance } from './components/lecturer-attendance';

// The lecturer's roster on the phone (limitation 83): reject a waiting check-in with a note, and check a
// student in by hand with how and why. Fake data only.
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
const mockCall = jest.fn();
const mockMe = { activeRole: 'LECTURER', permissions: ['attendance.assisted_checkin'] };
jest.mock('./lib/auth', () => ({ useAuth: () => ({ call: mockCall, me: mockMe }) }));

const line = (n: number, status: string | null) => ({
  studentId: `s${n}`,
  fullName: `Test Student ${n}`,
  studentNumber: `9900000${n}`,
  status,
  recordId: status ? `r${n}` : null,
  version: status ? 2 : null,
  lastAttempt: null,
});

beforeEach(() => {
  mockCall.mockReset();
  mockCall.mockImplementation(async (path: string, request?: { method?: string }) => {
    if (request?.method === 'POST') return {};
    if (path.endsWith('/attendance')) {
      return {
        data: {
          id: 'a1',
          status: 'OPEN',
          closesAt: '2030-08-20T10:20:00Z',
          lateAfter: '2030-08-20T10:15:00Z',
        },
      };
    }
    return {
      degraded: false,
      counts: { enrolled: 3, PRESENT: 0, notCheckedIn: 1 },
      students: [line(1, 'PENDING'), line(2, null), line(3, 'PRESENT')],
    };
  });
});

function show(classStatus = 'ACTIVE') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })}
    >
      <LecturerAttendance classId="c1" classStatus={classStatus} />
    </QueryClientProvider>,
  );
}

test('rejects a waiting check-in only with a note', async () => {
  await show();
  await fireEvent.press(await screen.findByText('Reject'));
  await fireEvent.press(screen.getByText('Reject check-in'));
  expect(await screen.findByText('Write a reason, at least 5 characters.')).toBeTruthy();
  expect(mockCall).not.toHaveBeenCalledWith(expect.stringContaining('/decide'), expect.anything());

  await fireEvent.changeText(
    screen.getByLabelText('Why is this check-in rejected?'),
    'Not in the room (test)',
  );
  await fireEvent.press(screen.getByText('Reject check-in'));
  expect(mockCall).toHaveBeenCalledWith('/attendance-records/r1/decide', {
    method: 'POST',
    body: { decision: 'REJECT', note: 'Not in the room (test)', version: 2 },
  });
});

test('checks a student in by hand with a method and a reason', async () => {
  await show();
  await fireEvent.press(await screen.findByText('Check a student in by hand'));
  // Only the student not checked in is listed (not the present one, not the waiting one).
  expect(screen.getAllByText('Check in by hand')).toHaveLength(1);
  expect(screen.queryByText(/Test Student 3/)).toBeNull();
  await fireEvent.press(screen.getByText('Check in by hand'));
  await fireEvent.changeText(screen.getByLabelText('Reason'), 'Phone battery died (test)');
  await fireEvent.press(screen.getByText('Check in'));
  expect(await screen.findByText('Choose why the student is checked in by hand.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Phone dead, lost or broken'));
  await fireEvent.press(screen.getByText('Check in'));
  expect(mockCall).toHaveBeenCalledWith('/attendance-sessions/a1/assisted-check-ins', {
    method: 'POST',
    body: { studentId: 's2', method: 'PHONE_UNAVAILABLE', reason: 'Phone battery died (test)' },
  });
});

test('offers hand check-in only while the class is running', async () => {
  await show('COMPLETED');
  await screen.findByText('Reject');
  expect(screen.queryByText('Check a student in by hand')).toBeNull();
});
