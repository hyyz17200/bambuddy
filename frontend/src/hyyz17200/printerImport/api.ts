import type { PrinterCreate } from '../../api/client';
import { hyyz17200Request } from '../request';

export interface ProbeResult {
  ip_address: string;
  serial_number: string | null;
  name: string | null;
  /** SSDP's model code ("N2S"), when SSDP answered. */
  model: string | null;
  source: 'ssdp' | 'certificate' | 'virtual' | null;
}

/** Read each printer's serial number from its IP. */
export async function probePrinters(ipAddresses: string[]): Promise<ProbeResult[]> {
  const response = await hyyz17200Request('/printers/import/probe', {
    method: 'POST',
    body: JSON.stringify({ ip_addresses: ipAddresses }),
  });
  return response.json();
}

/** Add one printer through upstream's Add Printer route; `verify` keeps its connection probe. */
export async function importPrinter(printer: PrinterCreate, verify: boolean): Promise<{ id: number; name: string }> {
  const response = await hyyz17200Request('/printers/import', {
    method: 'POST',
    body: JSON.stringify({ printer, verify }),
  });
  return response.json();
}
