import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { longDay, monthGrid, shortDay } from './components/date-field';
import { ExcuseFormScreen } from './screens/ExcuseFormScreen';

// The excuse form's dates are chosen from a calendar, not typed (KNOWN_LIMITATIONS 97). "Today" is fixed at
// Tuesday 2030-08-20; the API is a fake. Obviously fake data.
jest.mock('./lib/classes', () => ({
  ...jest.requireActual<typeof import('./lib/classes')>('./lib/classes'),
  localDay: () => '2030-08-20',
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ replace: jest.fn() }) }));
const mockCall = jest.fn();
jest.mock('./lib/auth', () => ({ useAuth: () => ({ call: mockCall }) }));

describe('the calendar', () => {
  test('lays out a month Monday first, with empty cells around it', () => {
    const august = monthGrid(2030, 7); // 1 August 2030 is a Thursday
    expect(august.slice(0, 4)).toEqual([null, null, null, '2030-08-01']);
    expect(august).toHaveLength(35);
    expect(august.filter(Boolean)).toHaveLength(31);
    expect(august[33]).toBe('2030-08-31');
    expect(monthGrid(2030, 8)[6]).toBe('2030-09-01'); // a Sunday ends the first row
    expect(monthGrid(2032, 1).filter(Boolean)).toHaveLength(29); // leap year
  });

  test('names days in full for screen readers and briefly on the field', () => {
    expect(longDay('2030-08-20')).toBe('Tuesday 20 August 2030');
    expect(shortDay('2030-08-20')).toBe('Tue 20 Aug 2030');
  });
});

describe('the excuse form', () => {
  const disabled = (label: string) =>
    Boolean(screen.getByLabelText(label).props.accessibilityState?.disabled);

  beforeEach(() => {
    mockCall.mockReset();
    mockCall.mockResolvedValue({ data: [] });
  });

  test('picks both dates from the calendar, keeps "To" after "From" and within 31 days, and asks with them', async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ExcuseFormScreen />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('From: Tuesday 20 August 2030')).toBeTruthy();
    expect(screen.queryByLabelText('Thursday 22 August 2030')).toBeNull(); // calendar closed

    await fireEvent.press(screen.getByLabelText('From: Tuesday 20 August 2030'));
    expect(screen.getByText('August 2030')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Thursday 22 August 2030'));
    // "To" was before the new "From", so it follows it; the calendar closes.
    expect(screen.getByLabelText('From: Thursday 22 August 2030')).toBeTruthy();
    expect(screen.getByLabelText('To: Thursday 22 August 2030')).toBeTruthy();
    expect(screen.queryByText('August 2030')).toBeNull();

    await fireEvent.press(screen.getByLabelText('To: Thursday 22 August 2030'));
    expect(disabled('Wednesday 21 August 2030')).toBe(true);
    expect(disabled('Friday 23 August 2030')).toBe(false);
    await fireEvent.press(screen.getByLabelText('Next month'));
    expect(screen.getByText('September 2030')).toBeTruthy();
    expect(disabled('Saturday 21 September 2030')).toBe(false); // the 31st day
    expect(disabled('Sunday 22 September 2030')).toBe(true);
    await fireEvent.press(screen.getByLabelText('Sunday 22 September 2030')); // refused: nothing changes
    expect(screen.getByLabelText('To: Thursday 22 August 2030')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Saturday 21 September 2030'));
    expect(screen.getByLabelText('To: Saturday 21 September 2030')).toBeTruthy();

    await fireEvent.press(screen.getByText('Find my classes in these dates'));
    expect(await screen.findByText('You have no classes in these dates.')).toBeTruthy();
    expect(mockCall).toHaveBeenCalledWith('/excuse-requests/covered?startDate=2030-08-22&endDate=2030-09-21');
  });
});
