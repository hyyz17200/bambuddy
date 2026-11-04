import type { TFunction } from 'i18next';
import type { BatchResult } from './runBatch';

/** The toast after a batch: how many went through, and which failed and why. */
export function summarize(
  t: TFunction,
  done: BatchResult<{ name: string }, unknown>,
  action: string,
): { message: string; type: 'success' | 'error' } {
  if (!done.failed.length) {
    return { message: t('hyyz17200.bulk.done', { action, count: done.ok.length }), type: 'success' };
  }
  return {
    message: t('hyyz17200.bulk.partial', {
      action,
      ok: done.ok.length,
      failed: done.failed.length,
      names: done.failed.map((f) => `${f.printer.name} (${f.error})`).join(', '),
    }),
    type: 'error',
  };
}

/** Selected printers sorted the way a person reads a list: P2 before P10. */
export function byName<T extends { name: string }>(printers: T[]): T[] {
  return [...printers].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** By location, then by name; printers without a location last. The order a
 *  batch calibration goes through a farm, shelf by shelf. */
export function byLocation<T extends { name: string; location?: string | null }>(printers: T[]): T[] {
  const key = (p: T) => p.location ?? '';
  return byName(printers).sort((a, b) => {
    if (!key(a) !== !key(b)) return key(a) ? -1 : 1;
    return key(a).localeCompare(key(b), undefined, { numeric: true });
  });
}
