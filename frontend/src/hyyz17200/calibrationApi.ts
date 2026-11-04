import { useQuery } from '@tanstack/react-query';
import { hyyz17200Request } from './request';

/** The only bits a batch sends (backend calibration_batch.py). */
export const BED_LEVELING = 1 << 1;
export const VIBRATION = 1 << 2;
export const MOTOR_NOISE = 1 << 3;

export type CalibrationBlocker = 'deleted' | 'maintenance' | 'offline' | 'plate_clear' | 'busy' | 'kill_switch';
export type CalibrationItemStatus = 'waiting' | 'starting' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface CalibrationItem {
  printer_id: number;
  name: string;
  status: CalibrationItemStatus;
  detail: string | null;
  blocker: CalibrationBlocker | null;
  option: number | null;
  motor_noise_skipped: boolean;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface CalibrationBatch {
  id: number;
  status: 'running' | 'finished' | 'cancelled';
  created_at: string | null;
  created_by: string | null;
  finished_at: string | null;
  bed_leveling: boolean;
  vibration: boolean;
  motor_noise: boolean;
  resume_intake: boolean;
  items: CalibrationItem[];
}

export interface CalibrationPreview {
  kill_switch: boolean;
  batch_running: boolean;
  printers: {
    printer_id: number;
    name: string;
    model: string | null;
    /** The printer reports motor noise cancellation; null: it reported nothing. */
    motor_noise: boolean | null;
    blocker: CalibrationBlocker | null;
  }[];
}

export interface CalibrationOptions {
  bed_leveling: boolean;
  vibration: boolean;
  motor_noise: boolean;
  resume_intake: boolean;
}

export const CALIBRATION_QUERY_KEY = ['hyyz17200', 'calibration'];

/** Still in the batch: not yet done one way or another. */
export const OPEN_STATUSES: CalibrationItemStatus[] = ['waiting', 'starting', 'running'];

export async function getCalibrationBatch(): Promise<CalibrationBatch | null> {
  return (await hyyz17200Request('/calibration/batch')).json();
}

export async function previewCalibration(printerIds: number[]): Promise<CalibrationPreview> {
  return (
    await hyyz17200Request('/calibration/preview', { method: 'POST', body: JSON.stringify({ printer_ids: printerIds }) })
  ).json();
}

export async function startCalibration(printerIds: number[], options: CalibrationOptions): Promise<CalibrationBatch> {
  return (
    await hyyz17200Request('/calibration/batch', {
      method: 'POST',
      body: JSON.stringify({ printer_ids: printerIds, ...options }),
    })
  ).json();
}

export async function cancelCalibration(): Promise<void> {
  await hyyz17200Request('/calibration/batch/cancel', { method: 'POST' });
}

/** The current batch, or the last one. Polled often while one runs. */
export function useCalibrationBatch() {
  return useQuery({
    queryKey: CALIBRATION_QUERY_KEY,
    queryFn: getCalibrationBatch,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 5_000 : 60_000),
  });
}
