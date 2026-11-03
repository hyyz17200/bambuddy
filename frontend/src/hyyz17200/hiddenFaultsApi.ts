import { hyyz17200Request } from './request';

export interface HiddenFault {
  code: string;
  note: string;
}

export const HIDDEN_FAULTS_QUERY_KEY = ['hyyz17200', 'hidden-faults'];

export async function listHiddenFaults(): Promise<HiddenFault[]> {
  return (await hyyz17200Request('/hidden-faults')).json();
}

export async function addHiddenFault(fault: HiddenFault): Promise<void> {
  await hyyz17200Request('/hidden-faults', { method: 'POST', body: JSON.stringify(fault) });
}

export async function removeHiddenFault(code: string): Promise<void> {
  await hyyz17200Request(`/hidden-faults/${code}`, { method: 'DELETE' });
}
