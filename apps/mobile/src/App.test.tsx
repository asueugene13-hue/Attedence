import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from './App';
import { tabsForRole } from './navigation/tabs';

// In-memory stand-in for the phone's secure storage.
const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockSecureStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockSecureStore.delete(key)),
}));

const TOKEN_KEY = 'attendsure.refreshToken';
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

function session(role: string, refreshToken = 'refresh-1') {
  return {
    client: 'MOBILE',
    accessToken: `access-${refreshToken}`,
    accessTokenExpiresAt: inAnHour(),
    refreshToken,
    sessionExpiresAt: inAnHour(),
    user: { id: 'u1', email: 'test.student@example.test', fullName: 'Test Student' },
    activeRole: role,
    roles: [role],
  };
}

const me = (role: string, roles = [role]) => ({
  user: { id: 'u1', email: 'test.student@example.test', fullName: 'Test Student', mfaEnabled: false },
  activeRole: role,
  roles,
  permissions: [],
});

type Route = (body: Record<string, unknown> | undefined) => { status: number; body?: unknown };
let routes: Record<string, Route>;
const calls: { path: string; body?: Record<string, unknown> }[] = [];

beforeEach(() => {
  mockSecureStore.clear();
  calls.length = 0;
  routes = {};
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api\/v1/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    const result = route ? route(body) : { status: 404, body: { code: 'NOT_FOUND', detail: 'Not found' } };
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
    });
  }) as typeof fetch;
});

describe('starting the app', () => {
  it('shows sign-in when no session is stored', async () => {
    await render(<App />);
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('resumes a stored session, rotating the refresh token', async () => {
    mockSecureStore.set(TOKEN_KEY, 'refresh-old');
    routes['POST /auth/refresh'] = (body) =>
      body?.refreshToken === 'refresh-old'
        ? { status: 200, body: session('STUDENT', 'refresh-new') }
        : { status: 401 };
    routes['GET /auth/me'] = () => ({ status: 200, body: me('STUDENT') });

    await render(<App />);
    expect(await screen.findByText('Hello, Test Student')).toBeTruthy();
    expect(mockSecureStore.get(TOKEN_KEY)).toBe('refresh-new');
  });

  it('forgets a session the server has ended and shows sign-in', async () => {
    mockSecureStore.set(TOKEN_KEY, 'refresh-revoked');
    routes['POST /auth/refresh'] = () => ({
      status: 401,
      body: { code: 'UNAUTHENTICATED', detail: 'ended' },
    });

    await render(<App />);
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(mockSecureStore.has(TOKEN_KEY)).toBe(false);
  });
});

describe('signing in', () => {
  it('signs a student in as a MOBILE client and keeps the refresh token in secure storage', async () => {
    routes['POST /auth/login'] = () => ({ status: 200, body: session('STUDENT') });
    routes['GET /auth/me'] = () => ({ status: 200, body: me('STUDENT') });

    await render(<App />);
    await fireEvent.changeText(await screen.findByLabelText('Email'), 'test.student@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'river-mango-lantern-42');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Hello, Test Student')).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toMatchObject({ client: 'MOBILE' });
    expect(mockSecureStore.get(TOKEN_KEY)).toBe('refresh-1');
    expect(screen.getByText(/check-in/)).toBeTruthy();
  });

  it('shows the server message for wrong credentials', async () => {
    routes['POST /auth/login'] = () => ({
      status: 401,
      body: { code: 'INVALID_CREDENTIALS', detail: 'The email or password is incorrect.' },
    });
    await render(<App />);
    await fireEvent.changeText(await screen.findByLabelText('Email'), 'x@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong-password-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The email or password is incorrect.')).toBeTruthy();
    expect(mockSecureStore.size).toBe(0);
  });

  it('sends staff who have not set up two-step sign-in to the web dashboard', async () => {
    routes['POST /auth/login'] = () => ({
      status: 200,
      body: { mfaRequired: true, enrollmentRequired: true, mfaToken: 'challenge-token-0000000000' },
    });
    await render(<App />);
    await fireEvent.changeText(await screen.findByLabelText('Email'), 'registrar@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'river-mango-lantern-42');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Set up on the web first')).toBeTruthy();
  });

  it('accepts a two-step code for staff who have set it up', async () => {
    routes['POST /auth/login'] = () => ({
      status: 200,
      body: { mfaRequired: true, enrollmentRequired: false, mfaToken: 'challenge-token-0000000000' },
    });
    routes['POST /auth/mfa/verify'] = (body) =>
      body?.code === '123456' ? { status: 200, body: session('REGISTRAR') } : { status: 401 };
    routes['GET /auth/me'] = () => ({ status: 200, body: me('REGISTRAR') });

    await render(<App />);
    await fireEvent.changeText(await screen.findByLabelText('Email'), 'registrar@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'river-mango-lantern-42');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(await screen.findByLabelText('6-digit code'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/tools are on the AttendSure web dashboard/)).toBeTruthy();
  });
});

describe('signing out', () => {
  it('ends the server session and removes the stored token', async () => {
    mockSecureStore.set(TOKEN_KEY, 'refresh-old');
    routes['POST /auth/refresh'] = () => ({ status: 200, body: session('LECTURER', 'refresh-new') });
    routes['GET /auth/me'] = () => ({ status: 200, body: me('LECTURER') });
    routes['POST /auth/logout'] = () => ({ status: 204 });

    await render(<App />);
    expect(await screen.findByText(/Start class/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Profile'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockSecureStore.has(TOKEN_KEY)).toBe(false));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(calls.some((c) => c.path === '/auth/logout')).toBe(true);
  });
});

describe('navigation', () => {
  it('lists only built screens as tabs', () => {
    expect(tabsForRole('STUDENT')).toEqual(['Home', 'Profile']);
    expect(tabsForRole('LECTURER')).toEqual(['Home', 'Profile']);
  });
});
