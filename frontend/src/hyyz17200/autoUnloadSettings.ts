/** Mirrors AutoUnloadSettings in backend/app/hyyz17200/auto_unload.py, defaults included. */
export interface AutoUnloadSettings {
  enabled: boolean;
  idle_minutes: number;
}

export const AUTO_UNLOAD_DEFAULTS: AutoUnloadSettings = { enabled: false, idle_minutes: 30 };
export const IDLE_MINUTES_RANGE = { min: 5, max: 720 };

/** Anything malformed or missing falls back to the default, field by field. */
export function normalizeAutoUnload(raw: unknown): AutoUnloadSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const minutes = value.idle_minutes;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : AUTO_UNLOAD_DEFAULTS.enabled,
    idle_minutes:
      Number.isInteger(minutes) &&
      (minutes as number) >= IDLE_MINUTES_RANGE.min &&
      (minutes as number) <= IDLE_MINUTES_RANGE.max
        ? (minutes as number)
        : AUTO_UNLOAD_DEFAULTS.idle_minutes,
  };
}
