import { ApiError, apiFetch, describeError } from './api';

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('API errors on the phone', () => {
  it('shows a server failure with its reference, so support can find it in the logs', async () => {
    respond(500, { code: 'INTERNAL_ERROR', detail: 'Something went wrong.', requestId: 'req-1234' });
    const error = await apiFetch('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).requestId).toBe('req-1234');
    expect(describeError(error)).toBe('Something went wrong. (reference req-1234)');
  });

  it('shows an ordinary refusal as the API worded it, without a reference', async () => {
    respond(403, { code: 'PERMISSION_DENIED', detail: 'You cannot do that.', requestId: 'req-5678' });
    expect(describeError(await apiFetch('/me').catch((e: unknown) => e))).toBe('You cannot do that.');
  });
});
