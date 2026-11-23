/** Mirrors CameraLedSettings in backend/app/hyyz17200/camera_led.py, defaults included. */
export interface CameraLedSettings {
  enabled: boolean;
  obico_force: boolean;
  off_delay_seconds: number;
  keep_camera_printer_ids: number[];
}

export const CAMERA_LED_DEFAULTS: CameraLedSettings = {
  enabled: false,
  obico_force: false,
  off_delay_seconds: 60,
  keep_camera_printer_ids: [],
};
export const OFF_DELAY_RANGE = { min: 0, max: 1800 };

/** Anything malformed or missing falls back to the default, field by field. */
export function normalizeCameraLed(raw: unknown): CameraLedSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const delay = value.off_delay_seconds;
  const keep = value.keep_camera_printer_ids;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : CAMERA_LED_DEFAULTS.enabled,
    obico_force: typeof value.obico_force === 'boolean' ? value.obico_force : CAMERA_LED_DEFAULTS.obico_force,
    off_delay_seconds:
      Number.isInteger(delay) && (delay as number) >= OFF_DELAY_RANGE.min && (delay as number) <= OFF_DELAY_RANGE.max
        ? (delay as number)
        : CAMERA_LED_DEFAULTS.off_delay_seconds,
    keep_camera_printer_ids: Array.isArray(keep)
      ? [...new Set(keep.filter((id): id is number => Number.isInteger(id)))].sort((a, b) => a - b)
      : [],
  };
}
