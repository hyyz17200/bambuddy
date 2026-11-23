import { hyyz17200Request } from '../request';

/** Mirrors ObicoSchedulerSettings in backend/app/hyyz17200/obico_scheduler.py, defaults included. */
export interface ObicoSchedulerSettings {
  enabled: boolean;
  max_concurrent: number;
  /** No checks before layer 1: the start sequence prints nothing. */
  skip_preparation: boolean;
}

export const OBICO_SCHEDULER_DEFAULTS: ObicoSchedulerSettings = {
  enabled: true,
  max_concurrent: 8,
  skip_preparation: true,
};
export const MAX_CONCURRENT_RANGE = { min: 1, max: 32 };

/** Anything malformed or missing falls back to the default, field by field. */
export function normalizeObicoScheduler(raw: unknown): ObicoSchedulerSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const limit = value.max_concurrent;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : OBICO_SCHEDULER_DEFAULTS.enabled,
    max_concurrent:
      Number.isInteger(limit) &&
      (limit as number) >= MAX_CONCURRENT_RANGE.min &&
      (limit as number) <= MAX_CONCURRENT_RANGE.max
        ? (limit as number)
        : OBICO_SCHEDULER_DEFAULTS.max_concurrent,
    skip_preparation:
      typeof value.skip_preparation === 'boolean' ? value.skip_preparation : OBICO_SCHEDULER_DEFAULTS.skip_preparation,
  };
}

/** One printer as GET /obico/scheduler reports it (ObicoScheduler.snapshot).
 *  Times are seconds; null until there is something to show. */
export interface ObicoSchedulerRow {
  printer_id: number;
  name: string | null;
  printing: boolean;
  in_flight: boolean;
  checks: number;
  ok: number;
  failed: number;
  consecutive_failures: number;
  overruns: number;
  waits: number;
  dropped_actions: number;
  /** Start to start, over the last checks of this print. */
  period: number | null;
  /** Verdict to verdict: what the printer is actually getting. */
  ok_period: number | null;
  last_ok_age: number | null;
  next_in: number | null;
  lag: number | null;
  capture: number | null;
  ml: number | null;
  total: number | null;
  capture_avg: number | null;
  ml_avg: number | null;
  total_avg: number | null;
}

export interface ObicoSchedulerStatus {
  mode: 'concurrent' | 'sequential';
  max_concurrent: number;
  skip_preparation: boolean;
  /** Printing but before layer 1, so not checked yet. */
  preparing: number;
  in_flight: number;
  interval: number | null;
  checks_last_minute: number;
  ok_last_minute: number;
  printers: ObicoSchedulerRow[];
}

export const OBICO_SCHEDULER_STATUS_KEY = ['hyyz17200', 'obico', 'scheduler'];

export async function getObicoScheduler(): Promise<ObicoSchedulerStatus> {
  return (await hyyz17200Request('/obico/scheduler')).json();
}

/** Checks a minute that every printing printer needs to be checked once an interval. */
export function targetPerMinute(status: ObicoSchedulerStatus): number | null {
  if (!status.interval) return null;
  const printing = status.printers.filter((row) => row.printing).length;
  return Math.round((printing * 60) / status.interval);
}

export function seconds(value: number | null, digits = 1): string {
  return value == null ? '—' : `${value.toFixed(digits)} s`;
}
