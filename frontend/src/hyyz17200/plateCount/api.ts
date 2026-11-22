import { hyyz17200Request } from '../request';

/** Mirrors PlateCountSettings in backend/app/hyyz17200/plate_count.py. */
export interface PlateCountSettings {
  enabled: boolean;
  default_capacity: number;
}

export const PLATE_COUNT_SECTION = 'plate_count';
/** MAX_CAPACITY in plate_count.py. */
export const MAX_PLATES = 99;

export function normalizePlateCount(raw: unknown): PlateCountSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const capacity = value.default_capacity;
  return {
    enabled: value.enabled === true,
    default_capacity:
      Number.isInteger(capacity) && (capacity as number) >= 1 && (capacity as number) <= MAX_PLATES
        ? (capacity as number)
        : 10,
  };
}

/** One printer in plate_count.overview(). */
export interface PrinterPlates {
  printer_id: number;
  /** Swaps its own plates: the plate-clear confirmation does not apply to it. */
  applicable: boolean;
  disabled: boolean;
  /** Its own capacity; null uses the default. */
  capacity: number | null;
  effective_capacity: number;
  counted: boolean;
  /** Clean plates in the machine, the bed's included. Null while not counted. */
  plates: number | null;
  /** Plates held by jobs printing (or finished and not yet counted). */
  in_use: number;
  /** Jobs it can still start. */
  available: number | null;
  /** The queue skips it: no clean plate left. */
  held: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface PlateOverview {
  enabled: boolean;
  default_capacity: number;
  plate_clear_setting: boolean;
  printers: PrinterPlates[];
}

export const PLATES_QUERY_KEY = ['hyyz17200', 'plates'];

export async function getPlateOverview(): Promise<PlateOverview> {
  return (await hyyz17200Request('/printers/plates')).json();
}

/** `plates` null fills it to its capacity. Rejects with detail `not_counted`
 *  when the printer is not counted. */
export async function setPrinterPlates(printerId: number, plates: number | null): Promise<void> {
  await hyyz17200Request(`/printers/${printerId}/plates`, { method: 'POST', body: JSON.stringify({ plates }) });
}

export async function setManyPlates(
  printerIds: number[],
  plates: number | null,
): Promise<{ updated: number[]; skipped: number[] }> {
  const response = await hyyz17200Request('/printers/plates/set', {
    method: 'POST',
    body: JSON.stringify({ printer_ids: printerIds, plates }),
  });
  return response.json();
}

export interface PlateConfigChange {
  disabled?: boolean;
  capacity?: number;
  /** Back to the default capacity. */
  default_capacity?: boolean;
}

export async function configurePlates(printerIds: number[], change: PlateConfigChange): Promise<void> {
  await hyyz17200Request('/printers/plates/config', {
    method: 'POST',
    body: JSON.stringify({ printer_ids: printerIds, ...change }),
  });
}

/** How the card shows it: red when the queue skips it, orange with two jobs or fewer left. */
export function plateLevel(entry: PrinterPlates): 'held' | 'low' | 'ok' {
  if (entry.held) return 'held';
  return (entry.available ?? 0) <= 2 ? 'low' : 'ok';
}
