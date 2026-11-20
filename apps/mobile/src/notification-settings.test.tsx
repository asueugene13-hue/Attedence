import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { NotificationSettingsScreen } from './screens/NotificationSettingsScreen';

// The phone's email settings (limitation 51): one switch per kind of message, locked on for mandatory ones.
const mockCall = jest.fn();
jest.mock('./lib/auth', () => ({ useAuth: () => ({ call: mockCall }) }));

const pref = (category: string, label: string, mandatory: boolean, enabled: boolean) => ({
  category,
  label,
  mandatory,
  channels: [
    { channel: 'EMAIL', available: true, enabled },
    { channel: 'PUSH', available: false, enabled: false },
  ],
});
const list = (excuseEmail: boolean) => ({
  data: [
    pref('CLASS_CANCELLED', 'Class cancelled', true, true),
    pref('EXCUSE_DECIDED', 'Your excuse request was decided', false, excuseEmail),
  ],
});

beforeEach(() => mockCall.mockReset());

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationSettingsScreen />
    </QueryClientProvider>,
  );
}

test('locks mandatory messages on and saves a change to another', async () => {
  mockCall.mockResolvedValueOnce(list(true)).mockResolvedValueOnce(list(false));
  await show();
  const cancelled = await screen.findByLabelText('Email: Class cancelled');
  expect(cancelled.props.value).toBe(true);
  expect(cancelled.props.disabled).toBe(true);
  expect(screen.getByText('Always emailed')).toBeTruthy();

  await fireEvent(screen.getByLabelText('Email: Your excuse request was decided'), 'valueChange', false);
  expect(mockCall).toHaveBeenLastCalledWith('/me/notification-preferences', {
    method: 'PUT',
    body: { category: 'EXCUSE_DECIDED', channel: 'EMAIL', enabled: false },
  });
  expect((await screen.findByLabelText('Email: Your excuse request was decided')).props.value).toBe(false);
});

test('shows the reason when a change is refused', async () => {
  mockCall.mockResolvedValueOnce(list(true)).mockRejectedValueOnce(new Error('Network down'));
  await show();
  await fireEvent(
    await screen.findByLabelText('Email: Your excuse request was decided'),
    'valueChange',
    false,
  );
  expect(await screen.findByText(/Network down|went wrong|could not/i)).toBeTruthy();
});
