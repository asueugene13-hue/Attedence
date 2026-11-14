import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { AppRoot } from './App';
import { CheckIdResult } from './screens/CheckIdScreen';

// Phase 6 phone screens: TESTING.md scenario 19 (a student disputes their attendance) on the phone, the
// digital student ID, requests and the lecturer's home. The API is a fake in this file; obviously fake data.
const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockSecureStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockSecureStore.delete(key)),
}));
jest.mock('expo-crypto', () => ({
  getRandomValues: <T extends Uint8Array>(array: T) =>
    jest.requireActual<typeof import('node:crypto')>('node:crypto').getRandomValues(array) as T,
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();
const trustedPhone = {
  id: 'd1',
  status: 'TRUSTED',
  isAttendanceDevice: true,
  trustRequestedAt: null,
  revokeReason: null,
};
let routes: Record<string, (body: Record<string, unknown> | undefined) => { status: number; body?: unknown }>;
const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
let offline = false;

function signedInAs(role: string) {
  mockSecureStore.set('attendsure.refreshToken', 'refresh-old');
  routes['POST /auth/refresh'] = () => ({
    status: 200,
    body: {
      client: 'MOBILE',
      accessToken: 'access-1',
      accessTokenExpiresAt: inAnHour(),
      refreshToken: 'refresh-new',
      sessionExpiresAt: inAnHour(),
      user: { id: 'u1', email: 'test.person@example.test', fullName: 'Test Person' },
      activeRole: role,
      roles: [role],
    },
  });
  routes['GET /auth/me'] = () => ({
    status: 200,
    body: {
      user: { id: 'u1', email: 'test.person@example.test', fullName: 'Test Person', mfaEnabled: false },
      activeRole: role,
      roles: [role],
      permissions: [],
    },
  });
}

beforeEach(() => {
  mockSecureStore.clear();
  calls.length = 0;
  offline = false;
  routes = {
    'GET /me/timetable': () => ({ status: 200, body: { data: [] } }),
    'GET /me/notifications/unread-count': () => ({ status: 200, body: { unread: 0 } }),
    'POST /me/devices': () => ({ status: 200, body: trustedPhone }),
    'GET /me/devices/current': () => ({ status: 200, body: trustedPhone }),
    'GET /disputes': () => ({ status: 200, body: { data: [] } }),
    'GET /excuse-requests': () => ({ status: 200, body: { data: [] } }),
    'GET /me/announcements': () => ({ status: 200, body: { data: [], nextCursor: null } }),
    'GET /announcements/targets': () => ({ status: 200, body: { kind: 'COURSE_REP', sections: [] } }),
    'GET /me/attendance': () => ({
      status: 200,
      body: {
        minimumPercent: null,
        data: [
          {
            offeringId: 'o1',
            course: { code: 'TST101', title: 'Test Course' },
            semester: { name: 'First (test)' },
            enrolled: true,
            eligible: 2,
            present: 1,
            late: 0,
            absences: 1,
            excused: 0,
            undecided: 0,
            cancelled: 0,
            percentage: 50,
            warning: null,
          },
        ],
      },
    }),
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError('Network request failed');
    const path = String(input).replace(/^.*\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body =
      init?.body && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    const result = route ? route(body) : { status: 404, body: { code: 'NOT_FOUND', detail: 'Not found' } };
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
    });
  }) as typeof fetch;
});

const start = () =>
  render(
    <AppRoot
      queryClient={new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })}
    />,
  );

const aDispute = (status: string, extra: object = {}) => ({
  id: 'dp1',
  status,
  reason: 'I was in the front row from 09:55 (test).',
  submittedAt: '2030-08-20T10:30:00Z',
  decidedAt: null,
  outcome: null,
  decisionNote: null,
  record: { id: 'r1', statusWhenDisputed: 'ABSENT', status: 'ABSENT' },
  class: {
    id: 'c2',
    scheduledStart: '2030-08-20T10:00:00Z',
    course: { code: 'TST101', title: 'Test Course' },
  },
  messages: [],
  attachments: [],
  attempts: [],
  ...extra,
});

describe('scenario 19 on the phone: a student disputes an absence', () => {
  it('opens the course, disputes the absent class with an explanation, and sees it waiting', async () => {
    signedInAs('STUDENT');
    routes['GET /me/attendance/offerings/o1'] = () => ({
      status: 200,
      body: {
        course: { code: 'TST101', title: 'Test Course' },
        percentage: 50,
        classes: [
          {
            classSessionId: 'c1',
            scheduledStart: '2030-08-19T10:00:00Z',
            counted: true,
            notCounted: null,
            outcome: 'PRESENT',
            record: 'PRESENT',
          },
          {
            classSessionId: 'c2',
            scheduledStart: '2030-08-20T10:00:00Z',
            counted: true,
            notCounted: null,
            outcome: 'ABSENT',
            record: 'ABSENT',
          },
        ],
      },
    });
    routes['POST /disputes'] = () => ({ status: 201, body: aDispute('SUBMITTED') });
    routes['GET /disputes/dp1'] = () => ({ status: 200, body: aDispute('SUBMITTED') });
    await start();
    await fireEvent.press(await screen.findByText('Attendance')); // the tab
    await fireEvent.press(await screen.findByRole('button', { name: /TST101 Test Course/ }));
    // Only the absent class can be disputed.
    expect(await screen.findAllByRole('button', { name: 'Dispute this record' })).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Dispute this record' }));
    const send = await screen.findByRole('button', { name: 'Send dispute' });
    expect(send.props.accessibilityState.disabled).toBe(true); // an explanation is required
    await fireEvent.changeText(
      screen.getByLabelText('What happened? (required)'),
      'I was in the front row from 09:55 (test).',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Send dispute' }));
    expect(await screen.findByText('Waiting for a decision')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/disputes')?.body).toEqual({
      classSessionId: 'c2',
      reason: 'I was in the front row from 09:55 (test).',
    });
  });

  it('answers the reviewer’s question from the request’s screen', async () => {
    signedInAs('STUDENT');
    const asked = aDispute('INFO_REQUESTED', {
      messages: [
        {
          kind: 'QUESTION',
          body: 'Which seat were you in? (test)',
          by: 'Test Lecturer',
          at: '2030-08-21T09:00:00Z',
        },
      ],
    });
    routes['GET /disputes'] = () => ({ status: 200, body: { data: [asked] } });
    routes['GET /disputes/dp1'] = () => ({ status: 200, body: asked });
    routes['POST /disputes/dp1/respond'] = () => ({ status: 200, body: aDispute('SUBMITTED') });
    await start();
    await fireEvent.press(await screen.findByRole('button', { name: /Dispute · TST101/ }));
    expect(await screen.findByText('Which seat were you in? (test)')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Your reply'), 'Front row (test)');
    await fireEvent.press(screen.getByRole('button', { name: 'Send reply' }));
    expect(calls.find((c) => c.path === '/disputes/dp1/respond')?.body).toEqual({
      reply: 'Front row (test)',
    });
  });
});

describe('the digital student ID', () => {
  it('shows the card and a code from the server, and hides the code when offline', async () => {
    signedInAs('STUDENT');
    routes['GET /me/student-id'] = () => ({
      status: 200,
      body: {
        student: {
          fullName: 'Test Person',
          studentNumber: '99000001',
          programme: { name: 'Test Programme' },
          level: { name: 'Level 100 (test)' },
          status: 'ACTIVE',
          hasPhoto: false,
        },
        code: {
          value: 'ASID1.abcdefghijklmnopqrstuv.1913364000.AAAAAAAAAAAAAAAAAAAAAA',
          expiresAt: inAnHour(),
          refreshAfterSeconds: 30,
        },
      },
    });
    const view = await start();
    await fireEvent.press(await screen.findByRole('button', { name: 'My student ID' }));
    expect(await screen.findByText('99000001')).toBeTruthy();
    expect(screen.getByLabelText('Your student ID code')).toBeTruthy();
    expect(screen.getByText('Active student')).toBeTruthy();
    await view.unmount();

    offline = true;
    signedInAs('STUDENT');
    const second = await start();
    // Without the server there is no session either; the sign-in screen says the server cannot be reached.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    await second.unmount();
  });

  it('staff see who a genuine code belongs to, or that it is not genuine', async () => {
    const genuine = await render(
      <CheckIdResult
        onAgain={() => undefined}
        result={{
          result: 'GENUINE',
          checkedAt: '2030-08-20T10:42:00Z',
          photo: null,
          student: {
            fullName: 'Test Person',
            studentNumber: '99000001',
            programme: { name: 'Test Programme' },
            level: null,
            status: 'SUSPENDED',
            active: false,
          },
        }}
      />,
    );
    expect(screen.getByText('Genuine ID · not an active student (suspended)')).toBeTruthy();
    expect(screen.getByText('99000001')).toBeTruthy();
    await genuine.unmount();
    const expired = await render(
      <CheckIdResult
        onAgain={() => undefined}
        result={{ result: 'EXPIRED', checkedAt: '', photo: null, student: null }}
      />,
    );
    expect(screen.getByText(/This code has expired/)).toBeTruthy();
    expect(screen.queryByText('99000001')).toBeNull();
    await expired.unmount();
  });
});

describe('the lecturer’s home', () => {
  it('shows only real counts of what waits, and the sections', async () => {
    signedInAs('LECTURER');
    routes['GET /me/lecturer-dashboard'] = () => ({
      status: 200,
      body: {
        waiting: {
          disputes: { count: 2, oldestWaitingSince: null },
          checkIns: 0,
          corrections: { waiting: 0, answeredThisWeek: 0 },
        },
        excusedThisWeek: 1,
        minimumPercent: null,
        sections: [
          {
            sectionId: 's1',
            code: 'A',
            course: { code: 'TST101' },
            students: 3,
            classesHeld: 4,
            percentage: 75,
          },
        ],
      },
    });
    await start();
    const waiting = await screen.findByText('Waiting for you');
    expect(waiting).toBeTruthy();
    expect(screen.getByText('Disputes to decide')).toBeTruthy();
    expect(screen.queryByText('Check-ins waiting')).toBeNull(); // zero: not shown
    expect(within(screen.getByText('TST101 · A').parent!.parent!).getByText('75%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check a student ID' })).toBeTruthy();
  });
});
