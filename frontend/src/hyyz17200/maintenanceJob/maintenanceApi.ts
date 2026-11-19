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

/** Sends the file now. Rejects with a Hyyz17200RequestError whose `detail` is
 *  a short code (offline, busy, wrong_model, ...). */
export async function sendMaintenanceJob(
  printerId: number,
  libraryFileId: number,
  clearsPlate: boolean,
): Promise<{ queue_item_id: number }> {
  const response = await hyyz17200Request(`/printers/${printerId}/maintenance-job`, {
    method: 'POST',
    body: JSON.stringify({ library_file_id: libraryFileId, clears_plate: clearsPlate }),
  });
  return response.json();
}

// "Plate is clear afterwards", remembered per file in this browser.
const CLEARS_PLATE_KEY = 'hyyz17200.maintenance.clearsPlate';

function readClearing(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLEARS_PLATE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

export function rememberedClearsPlate(fileId: number): boolean {
  return readClearing().includes(fileId);
}

export function rememberClearsPlate(fileId: number, clears: boolean): void {
  const ids = readClearing().filter((id) => id !== fileId);
  if (clears) ids.push(fileId);
  try {
    localStorage.setItem(CLEARS_PLATE_KEY, JSON.stringify(ids));
  } catch {
    // Not remembered; the next send starts unticked.
  }
}
