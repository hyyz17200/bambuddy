import { getAuthToken } from '../api/client';

/** A non-2xx answer. `detail` is the API's own `detail` when it is a string. */
export class Hyyz17200RequestError extends Error {
  readonly status: number;
  readonly detail: string | undefined;

  constructor(status: number, detail: string | undefined) {
    super(`HTTP ${status}`);
    this.name = 'Hyyz17200RequestError';
    this.status = status;
    this.detail = detail;
  }
}

/** A request to the fork's API under /api/v1/hyyz17200, with the user's token.
 *  Throws a `Hyyz17200RequestError` on any non-2xx answer. */
export async function hyyz17200Request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const response = await fetch(`/api/v1/hyyz17200${path}`, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Hyyz17200RequestError(response.status, detail);
  }
  return response;
}
