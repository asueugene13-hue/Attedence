import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { CourseAttendanceScreen } from './screens/CourseAttendanceScreen';

// A course's page lists the classes already held first (newest first), then the next few not held yet,
// so future classes do not push the records down (found in the 2026-11-20 phone test). Fake data.
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { offeringId: 'o1' } }),
  useNavigation: () => ({ navigate: jest.fn() }),
}));
const mockCall = jest.fn();
jest.mock('./lib/auth', () => ({ useAuth: () => ({ call: mockCall }) }));

const cls = (n: number, over: Record<string, unknown>) => ({
  classSessionId: `c${n}`,
  scheduledStart: `2030-08-${String(n).padStart(2, '0')}T10:00:00Z`,
  counted: false,
  notCounted: null,
  outcome: null,
  record: null,
  ...over,
});

test('shows held classes first, newest first, then the next three classes not held yet', async () => {
  // As the API sends them: oldest first.
  mockCall.mockResolvedValue({
    course: { code: 'TST101', title: 'Test Course' },
    percentage: 50,
    classes: [
      cls(5, { counted: true, record: 'PRESENT' }),
      cls(7, { notCounted: 'CANCELLED' }),
      cls(12, { counted: true, record: 'ABSENT' }),
      ...[19, 21, 26, 28, 30].map((n) => cls(n, { notCounted: 'NOT_HELD_YET' })),
    ],
  });
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <CourseAttendanceScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('So far');
  const texts = screen
    .getAllByText(/./)
    .map((t) => [t.props.children].flat().join(''))
    .filter((t) =>
      /^(So far|Coming up|Present|Absent|Cancelled \(not counted\)|Not held yet|And \d+ more)/.test(t),
    );
  expect(texts).toEqual([
    'So far',
    'Absent', // the 12th, newest held class first
    'Cancelled (not counted)',
    'Present',
    'Coming up',
    'Not held yet',
    'Not held yet',
    'Not held yet',
    'And 2 more later this semester.',
  ]);
  expect(screen.getByText('Dispute this record')).toBeTruthy();
});
