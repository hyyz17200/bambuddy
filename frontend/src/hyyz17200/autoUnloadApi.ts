import { hyyz17200Request } from './request';

/** How a printer's last auto unload ended (auto_unload._record). */
export interface AutoUnloadResult {
  result: string;
  detail: string | null;
  at: string;
}

/** One printer as GET /auto-unload/status reports it. A printer the loop has
 *  not seen (not connected, or auto unload off) has only the first four. */
export interface AutoUnloadRow {
  printer_id: number;
  name: string;
  model: string | null;
  is_active: boolean;
  state?: string;
  tray_now?: number | null;
  ams_status_main?: number | null;
  idle_seconds?: number | null;
  /** Why it is not being unloaded now; null when nothing holds it back. */
  reason?: string | null;
  tried?: boolean;
  unloading?: boolean;
  last?: AutoUnloadResult;
}

export interface AutoUnloadStatus {
  enabled: boolean;
  idle_minutes: number;
  printers: AutoUnloadRow[];
}

export async function getAutoUnloadStatus(): Promise<AutoUnloadStatus> {
  return (await hyyz17200Request('/auto-unload/status')).json();
}

/** Reasons that are just how a printer is. Mirrors QUIET_REASONS in auto_unload.py. */
const QUIET = new Set(['offline', 'not_idle', 'nothing_loaded', 'external_spool']);

/** attention: idle and held back for an unexpected reason, or tried and still
 *  loaded. Then what is happening, what will happen, and the rest. */
export type AutoUnloadGroup = 'attention' | 'unloading' | 'waiting' | 'quiet';

export const GROUP_ORDER: AutoUnloadGroup[] = ['attention', 'unloading', 'waiting', 'quiet'];

export interface AutoUnloadView {
  group: AutoUnloadGroup;
  /** A key under hyyz17200.autoUnload.status.reason */
  key: string;
}

export function viewOf(row: AutoUnloadRow): AutoUnloadView {
  if (row.reason === undefined) return { group: 'quiet', key: row.is_active ? 'offline' : 'maintenance' };
  if (row.unloading) return { group: 'unloading', key: 'unloading' };
  if (row.reason === null) return row.tried ? { group: 'attention', key: 'tried' } : { group: 'waiting', key: 'waiting' };
  if (QUIET.has(row.reason)) return { group: 'quiet', key: row.reason };
  return { group: 'attention', key: row.reason };
}

/** Problems first, then by name with numbers in order (A1-9 before A1-10). */
export function sortRows(rows: AutoUnloadRow[]): AutoUnloadRow[] {
  return [...rows].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(viewOf(a).group) - GROUP_ORDER.indexOf(viewOf(b).group) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
