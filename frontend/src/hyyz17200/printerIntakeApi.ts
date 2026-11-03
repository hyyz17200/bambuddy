import { hyyz17200Request } from './request';

export interface IntakeStop {
  printer_id: number;
  stopped_at: string | null;
  stopped_by: string | null;
}

export const INTAKE_STOPS_QUERY_KEY = ['hyyz17200', 'intake-stops'];

export async function listIntakeStops(): Promise<IntakeStop[]> {
  return (await hyyz17200Request('/printers/intake-stops')).json();
}

export async function setPrinterIntake(printerId: number, stopped: boolean): Promise<void> {
  await hyyz17200Request(`/printers/${printerId}/intake`, {
    method: 'PUT',
    body: JSON.stringify({ stopped }),
  });
}
