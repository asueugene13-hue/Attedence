/** A problem-details error from the API (docs/API_DOCUMENTATION.md §1). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: { field: string | null; message: string }[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  accessToken?: string | null;
  signal?: AbortSignal;
}

/** Calls the API through the dashboard's own /api/v1 proxy. Throws ApiError for any non-2xx answer. */
export async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  if (request.accessToken) headers.Authorization = `Bearer ${request.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      credentials: 'same-origin',
      signal: request.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'AttendSure could not be reached. Check your connection and try again.',
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data: unknown = text ? safeJson(text) : undefined;
  if (response.ok) return data as T;

  const problem = (data ?? {}) as { code?: string; detail?: string; errors?: unknown; requestId?: string };
  const fieldErrors = Array.isArray(problem.errors)
    ? (problem.errors as { field?: string | null; message?: string }[]).map((e) => ({
        field: e.field ?? null,
        message: e.message ?? 'is not valid',
      }))
    : [];
  throw new ApiError(
    response.status,
    problem.code ?? 'ERROR',
    problem.detail ?? 'Something went wrong. Please try again.',
    fieldErrors,
    problem.requestId,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A message suitable to show a person, including the request ID they can quote for support. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.fieldErrors
      .map((e) => (e.field ? `${e.field}: ${e.message}` : e.message))
      .join('; ');
    const base = fields && error.code === 'VALIDATION_FAILED' ? `${error.message} ${fields}` : error.message;
    return error.status >= 500 && error.requestId ? `${base} (reference ${error.requestId})` : base;
  }
  return 'Something went wrong. Please try again.';
}
