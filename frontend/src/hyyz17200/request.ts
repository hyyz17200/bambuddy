import { getAuthToken } from '../api/client';

/** A request to the fork's API under /api/v1/hyyz17200, with the user's token.
 *  Throws on any non-2xx answer. */
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
