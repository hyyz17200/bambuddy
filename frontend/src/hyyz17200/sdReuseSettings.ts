/** Mirrors SdReuseSettings in backend/app/hyyz17200/sd_reuse.py. */
export interface SdReuseSettings {
  enabled: boolean;
}

/** The kept file's name on the card; CACHE_NAME in sd_reuse.py. */
export const SD_REUSE_CACHE_FILE = 'hyyz17200-last.bbcache';

/** Off unless saved on. */
export function normalizeSdReuse(raw: unknown): SdReuseSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { enabled: value.enabled === true };
}
