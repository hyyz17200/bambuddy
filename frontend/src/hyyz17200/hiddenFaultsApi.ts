import { getAuthToken } from '../api/client';

export interface HiddenFault {
  code: string;
  note: string;
}

export const HIDDEN_FAULTS_QUERY_KEY = ['hyyz17200', 'hidden-faults'];

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const response = await fetch(`/api/v1/hyyz17200/hidden-faults${path}`, {
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

export async function listHiddenFaults(): Promise<HiddenFault[]> {
  return (await send('')).json();
}

export async function addHiddenFault(fault: HiddenFault): Promise<void> {
  await send('', { method: 'POST', body: JSON.stringify(fault) });
}

export async function removeHiddenFault(code: string): Promise<void> {
  await send(`/${code}`, { method: 'DELETE' });
}
