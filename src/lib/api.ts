/** Calls to the app's own backend (/api/...). */
import { API_HEADER, type ErrorResponse } from '../../shared/api';

export class ApiError extends Error {
  /** HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;
  readonly kind?: string;
  constructor(status: number, message: string, kind?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;
let getToken: TokenProvider = async () => null;
let onSignedOut: () => void = () => {};

/** Called by auth.ts once it knows how to get the signed-in user's access token. */
export function configureApiAuth(provider: TokenProvider, signedOut: () => void) {
  getToken = provider;
  onSignedOut = signedOut;
}

async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(API_HEADER, '1');
  if (token) headers.set('authorization', `Bearer ${token}`);
  try {
    return await fetch(path, { ...init, headers });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'The server could not be reached. Check your connection.', 'offline');
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let response = await send(path, init, await getToken());
  if (response.status === 401) {
    // The token may have just expired: refresh it once and try again.
    const fresh = await getToken(true);
    if (fresh) response = await send(path, init, fresh);
    if (response.status === 401) {
      onSignedOut();
      throw new ApiError(401, 'Your sign-in has expired. Sign in again.', 'unauthorized');
    }
  }
  return response;
}

export async function readError(response: Response): Promise<ApiError> {
  let body: Partial<ErrorResponse> = {};
  try {
    body = (await response.json()) as Partial<ErrorResponse>;
  } catch {
    // Not JSON, e.g. a gateway timeout page.
  }
  const message =
    typeof body.error === 'string' && body.error
      ? body.error
      : response.status === 504 || response.status === 503
        ? 'The server took too long to answer. Try again.'
        : `The server answered with an error (${response.status}).`;
  return new ApiError(response.status, message, body.kind);
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}
