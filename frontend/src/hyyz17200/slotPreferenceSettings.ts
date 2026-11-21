/** Mirrors SlotPreferenceSettings in backend/app/hyyz17200/slot_preference.py. */
export interface SlotPreferenceSettings {
  enabled: boolean;
}

/** Off unless saved on. */
export function normalizeSlotPreference(raw: unknown): SlotPreferenceSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { enabled: value.enabled === true };
}
