import { hyyz17200Request } from '../request';

export type SliceItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type SliceBatchStatus = 'queued' | 'running' | 'finished' | 'cancelled';

export interface SliceItem {
  file_id: number;
  name: string;
  status: SliceItemStatus;
  /** Why it was skipped: not_found, not_3mf, no_settings, already_sliced, missing, unreadable. */
  reason: string | null;
  /** Why it failed, from the slicer or Bambuddy. */
  detail: string | null;
  plate_count: number;
  output_file_id: number | null;
  output_name: string | null;
  progress: { stage: string | null; total_percent: number | null } | null;
}

export interface SliceBatch {
  id: number;
  status: SliceBatchStatus;
  created_at: string;
  finished_at: string | null;
  items: SliceItem[];
}

export const SLICE_BATCHES_QUERY_KEY = ['hyyz17200', 'slice-as-designed'] as const;

const PATH = '/library/slice-as-designed';

export async function listSliceBatches(): Promise<SliceBatch[]> {
  return (await hyyz17200Request(PATH)).json();
}

export async function startSliceBatch(fileIds: number[]): Promise<SliceBatch> {
  const response = await hyyz17200Request(PATH, { method: 'POST', body: JSON.stringify({ file_ids: fileIds }) });
  return response.json();
}

export async function cancelSliceBatch(id: number): Promise<SliceBatch> {
  return (await hyyz17200Request(`${PATH}/${id}/cancel`, { method: 'POST' })).json();
}

export function isOpen(batch: SliceBatch): boolean {
  return batch.finished_at === null;
}

/** A 3MF project rather than a sliced file: what the batch can take. */
export function isProjectThreeMf(file: { filename: string; file_type?: string | null }): boolean {
  const lower = (file.filename || '').toLowerCase();
  const type = (file.file_type || '').toLowerCase();
  return lower.endsWith('.3mf') && !lower.endsWith('.gcode.3mf') && type !== 'gcode.3mf' && type !== 'gcode';
}
