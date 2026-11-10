/**
 * Where the app reaches the AttendSure API. Expo builds EXPO_PUBLIC_* variables into the app.
 * The Android emulator reaches this PC as 10.0.2.2; a phone on Wi-Fi needs the PC's local address;
 * production uses the university's HTTPS API address.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: { field: string | null; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  accessToken?: string | null;
  /** Extra headers, such as a phone's signature. */
  headers?: Record<string, string>;
  /** The body exactly as signed (sent as is instead of encoding `body`). */
  rawBody?: string;
}

/** Calls the API. Throws ApiError for any non-2xx answer, using the API's problem-details body. */
export async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
  const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (request.accessToken) headers.Authorization = `Bearer ${request.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      method: request.method ?? 'GET',
      headers,
      body,
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'AttendSure could not be reached. Check your internet connection.',
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (response.ok) return data as T;

  const problem = (data ?? {}) as { code?: string; detail?: string; errors?: unknown };
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
  );
}

export function describeError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}
