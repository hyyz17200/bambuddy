/** Mirrors CameraLedSettings in backend/app/hyyz17200/camera_led.py, defaults included. */
export interface CameraLedSettings {
  enabled: boolean;
  obico_force: boolean;
  off_delay_seconds: number;
  /** Keep the camera connected while printing, for every printer by default. */
  keep_camera_all: boolean;
  /** Per printer, whatever keep_camera_all says: on, and off. */
  keep_camera_printer_ids: number[];
  keep_camera_off_ids: number[];
}

export const CAMERA_LED_DEFAULTS: CameraLedSettings = {
  enabled: false,
  obico_force: false,
  off_delay_seconds: 60,
  keep_camera_all: false,
  keep_camera_printer_ids: [],
  keep_camera_off_ids: [],
};
export const OFF_DELAY_RANGE = { min: 0, max: 1800 };

export type KeepCameraChoice = 'follow' | 'on' | 'off';
export const KEEP_CAMERA_CHOICES: KeepCameraChoice[] = ['follow', 'on', 'off'];

function idList(raw: unknown): number[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is number => Number.isInteger(id)))].sort((a, b) => a - b)
    : [];
}

/** Anything malformed or missing falls back to the default, field by field. A
 *  printer listed both on and off is on, as the backend reads it. */
export function normalizeCameraLed(raw: unknown): CameraLedSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const delay = value.off_delay_seconds;
  const on = idList(value.keep_camera_printer_ids);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : CAMERA_LED_DEFAULTS.enabled,
    obico_force: typeof value.obico_force === 'boolean' ? value.obico_force : CAMERA_LED_DEFAULTS.obico_force,
    off_delay_seconds:
      Number.isInteger(delay) && (delay as number) >= OFF_DELAY_RANGE.min && (delay as number) <= OFF_DELAY_RANGE.max
        ? (delay as number)
        : CAMERA_LED_DEFAULTS.off_delay_seconds,
    keep_camera_all: typeof value.keep_camera_all === 'boolean' ? value.keep_camera_all : false,
    keep_camera_printer_ids: on,
    keep_camera_off_ids: idList(value.keep_camera_off_ids).filter((id) => !on.includes(id)),
  };
}

export function keepCameraChoice(settings: CameraLedSettings, id: number): KeepCameraChoice {
  if (settings.keep_camera_printer_ids.includes(id)) return 'on';
  if (settings.keep_camera_off_ids.includes(id)) return 'off';
  return 'follow';
}

export function keepsCamera(settings: CameraLedSettings, id: number): boolean {
  const choice = keepCameraChoice(settings, id);
  return choice === 'follow' ? settings.keep_camera_all : choice === 'on';
}

/** The settings with these printers set to one choice. */
export function withKeepCameraChoice(
  settings: CameraLedSettings,
  ids: number[],
  choice: KeepCameraChoice,
): CameraLedSettings {
  const on = new Set(settings.keep_camera_printer_ids);
  const off = new Set(settings.keep_camera_off_ids);
  for (const id of ids) {
    on.delete(id);
    off.delete(id);
    if (choice === 'on') on.add(id);
    if (choice === 'off') off.add(id);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { ...settings, keep_camera_printer_ids: sorted(on), keep_camera_off_ids: sorted(off) };
}
