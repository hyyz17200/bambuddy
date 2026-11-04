/** The Enhanced Settings' cam wall section. Mirrors CamWallSettings in
 *  backend/app/hyyz17200/camera_frames.py, defaults included. */
export interface CamWallSettings {
  max_concurrent_captures: number;
}

export const CAM_WALL_DEFAULTS: CamWallSettings = { max_concurrent_captures: 2 };
export const CONCURRENCY_RANGE = { min: 1, max: 16 };

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;

/** Anything malformed or missing falls back to the default. */
export function normalizeCamWall(raw: unknown): CamWallSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    max_concurrent_captures: inRange(value.max_concurrent_captures, CONCURRENCY_RANGE)
      ? value.max_concurrent_captures
      : CAM_WALL_DEFAULTS.max_concurrent_captures,
  };
}
