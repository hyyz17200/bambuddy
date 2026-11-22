import { api } from '../../api/client';
import type { Printer } from '../../api/client';

/** The fork's plate tools on upstream's plate changer count (#3575): the count
 *  lives on the printer (`plate_capacity`, `plates_remaining`,
 *  `plate_changer_show_count`), set through PATCH /printers/{id} (printers:update)
 *  and refilled through POST /printers/{id}/refill-plates (printers:clear_plate). */

/** PrinterUpdate's limit for plate_capacity and plates_remaining. */
export const MAX_PLATES = 999;
/** What the bulk dialog and the settings page offer for a printer not counted yet. */
export const DEFAULT_CAPACITY = 10;

export type PlatePrinter = Pick<Printer, 'id' | 'name'> & {
  plate_capacity?: number | null;
  plates_remaining?: number | null;
  plate_changer_show_count?: boolean;
};

export function isCounted<P extends PlatePrinter>(printer: P): printer is P & { plate_capacity: number } {
  return printer.plate_capacity != null;
}

/** Plates left as upstream reads them: no count with a capacity set reads as empty. */
export function platesLeft(printer: PlatePrinter): number | null {
  return printer.plate_capacity == null ? null : Math.max(0, printer.plates_remaining ?? 0);
}

export function setPlatesRemaining(printerId: number, plates: number): Promise<Printer> {
  return api.updatePrinter(printerId, { plates_remaining: plates });
}

/** Null switches counting off. Turning it on starts from a full changer. */
export function setPlateCapacity(printerId: number, capacity: number | null): Promise<Printer> {
  return api.updatePrinter(printerId, { plate_capacity: capacity });
}

export function setPlateShowCount(printerId: number, show: boolean): Promise<Printer> {
  return api.updatePrinter(printerId, { plate_changer_show_count: show });
}

/** Set `plates` on one printer (cut to its capacity). A full changer goes through
 *  upstream's refill when the user may clear plates, otherwise through the edit. */
export function setPlates(
  printer: PlatePrinter & { plate_capacity: number },
  plates: number,
  canRefill: boolean,
): Promise<Printer> {
  const value = Math.max(0, Math.min(plates, printer.plate_capacity));
  return value === printer.plate_capacity && canRefill ? api.refillPlates(printer.id) : setPlatesRemaining(printer.id, value);
}

export function parseWhole(text: string, min: number, max: number): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
