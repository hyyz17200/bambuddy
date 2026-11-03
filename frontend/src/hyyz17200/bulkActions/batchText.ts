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
