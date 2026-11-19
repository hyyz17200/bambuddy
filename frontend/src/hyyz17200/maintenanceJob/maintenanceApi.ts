import { hyyz17200Request } from '../request';

/** Mirrors MaintenanceSettings in backend/app/hyyz17200/maintenance_jobs.py. */
export interface MaintenanceSettings {
  folder_id: number | null;
}

export const MAINTENANCE_SECTION = 'maintenance';

export function normalizeMaintenance(raw: unknown): MaintenanceSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const folder = value.folder_id;
  return { folder_id: Number.isInteger(folder) && (folder as number) > 0 ? (folder as number) : null };
}

/** Only sliced 3MFs are offered; a plain 3MF has no G-code to send. */
export function isMaintenanceFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.gcode.3mf');
}

/** Sends the file now, and with `stopIntake` stops the printer taking queue
 *  jobs. Rejects with a Hyyz17200RequestError whose `detail` is a short code
 *  (offline, busy, plate_clear, wrong_model, ...). */
export async function sendMaintenanceJob(
  printerId: number,
  libraryFileId: number,
  stopIntake: boolean,
): Promise<{ queue_item_id: number; intake_stopped: boolean }> {
  const response = await hyyz17200Request(`/printers/${printerId}/maintenance-job`, {
    method: 'POST',
    body: JSON.stringify({ library_file_id: libraryFileId, stop_intake: stopIntake }),
  });
  return response.json();
}
