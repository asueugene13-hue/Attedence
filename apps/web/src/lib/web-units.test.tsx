import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReasonDialog } from '@/components/reason-dialog';
import { ApiError, apiFetch, describeError } from './api';
import { visibleNavItems } from './navigation';

beforeAll(() => {
  // jsdom may not implement <dialog> modality; give it the minimum the component uses.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void };
  if (!proto.showModal || !String(proto.showModal).includes('[native code]')) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

describe('apiFetch', () => {
  it('sends FormData as it is, adds extra headers, and returns files as blobs', async () => {
    const fetchMock = vi.fn(async () => new Response('a,b', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.csv');
    const blob = await apiFetch<Blob>('/imports/students', {
      method: 'POST',
      body: form,
      headers: { 'If-Match': '3' },
      responseType: 'blob',
    });
    expect(await blob.text()).toBe('a,b');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(form);
    const headers = init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('3');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('keeps non-list error details, such as missing import columns', async () => {
    respond(400, {
      status: 400,
      code: 'COLUMNS_DO_NOT_MATCH',
      detail: 'The columns do not match.',
      errors: { missing: ['email'], unknown: [] },
    });
    const error = await apiFetch('/imports/students').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details).toEqual({ missing: ['email'], unknown: [] });
    expect((error as ApiError).fieldErrors).toEqual([]);
  });

  it('returns JSON for success and undefined for 204', async () => {
    respond(200, { ok: true });
    expect(await apiFetch('/x')).toEqual({ ok: true });
    respond(204);
    expect(await apiFetch('/x', { method: 'POST' })).toBeUndefined();
  });

  it('turns problem details into an ApiError with field errors', async () => {
    respond(400, {
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'The request is not valid.',
      errors: [{ field: 'email', message: 'Invalid email address' }],
    });
    const error = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors).toEqual([{ field: 'email', message: 'Invalid email address' }]);
    expect(describeError(error)).toContain('email: Invalid email address');
  });

  it('reports a network failure in plain words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const error = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(describeError(error)).toMatch(/could not be reached/);
  });

  it('adds the request reference to server errors so it can be quoted', () => {
    const error = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.', [], 'req-123');
    expect(describeError(error)).toContain('req-123');
  });

  it('sends the access token and JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/users', { method: 'POST', body: { a: 1 }, accessToken: 'tok' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/users');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.body).toBe('{"a":1}');
  });
});

describe('sidebar', () => {
  it('shows only screens the role may use', () => {
    expect(visibleNavItems([]).map((i) => i.label)).toEqual(['Home']);
    expect(visibleNavItems(['users.manage_admins', 'audit_logs.read']).map((i) => i.label)).toEqual([
      'Home',
      'Accounts',
      'Audit log',
    ]);
  });

  it('shows Bulk import to anyone who may import either kind', () => {
    const registrar = ['students.read_full', 'students.import', 'enrollments.manage'];
    expect(visibleNavItems(registrar).map((i) => i.label)).toEqual([
      'Home',
      'Students',
      'Bulk import',
      'Enrolments',
    ]);
    expect(visibleNavItems(['enrollments.manage']).map((i) => i.label)).toEqual([
      'Home',
      'Bulk import',
      'Enrolments',
    ]);
  });
});

describe('ReasonDialog', () => {
  it('will not confirm without a reason, then sends the trimmed reason', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <ReasonDialog
        open
        title="Suspend?"
        description="d"
        confirmLabel="Suspend account"
        destructive
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Suspend account', hidden: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 5 characters/)).toBeTruthy();

    await user.type(screen.getByLabelText(/Reason/), '  Left the university  ');
    await user.click(screen.getByRole('button', { name: 'Suspend account', hidden: true }));
    expect(onConfirm).toHaveBeenCalledWith('Left the university');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error and stays open', async () => {
    const onClose = vi.fn();
    render(
      <ReasonDialog
        open
        title="t"
        description="d"
        confirmLabel="Go"
        onConfirm={async () => {
          throw new ApiError(409, 'LAST_SUPER_ADMIN', 'This is the only active Super Admin.');
        }}
        onClose={onClose}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reason/), 'Testing the error');
    await user.click(screen.getByRole('button', { name: 'Go', hidden: true }));
    expect(await screen.findByText('This is the only active Super Admin.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
