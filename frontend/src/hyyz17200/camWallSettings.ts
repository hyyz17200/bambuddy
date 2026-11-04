import { useSyncExternalStore } from 'react';

/** The Enhanced Settings' cam wall section. Mirrors CamWallSettings in
 *  backend/app/hyyz17200/camera_frames.py, defaults included. */
export interface CamWallSettings {
  max_concurrent_captures: number;
  /** The most the wall's own "Max live streams" knob goes to. Upstream: 16. */
  max_live_limit: number;
}

export const CAM_WALL_DEFAULTS: CamWallSettings = { max_concurrent_captures: 2, max_live_limit: 16 };
export const CONCURRENCY_RANGE = { min: 1, max: 16 };
export const MAX_LIVE_LIMIT_RANGE = { min: 1, max: 256 };

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;

/** Anything malformed or missing falls back to the default, field by field. */
export function normalizeCamWall(raw: unknown): CamWallSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    max_concurrent_captures: inRange(value.max_concurrent_captures, CONCURRENCY_RANGE)
      ? value.max_concurrent_captures
      : CAM_WALL_DEFAULTS.max_concurrent_captures,
    max_live_limit: inRange(value.max_live_limit, MAX_LIVE_LIMIT_RANGE)
      ? value.max_live_limit
      : CAM_WALL_DEFAULTS.max_live_limit,
  };
}

// The last limit seen, so a kiosk wall that cannot fetch the settings uses this
// browser's, and a reload does not briefly cut the live tiles back to 16.
const CACHE_KEY = 'hyyz17200CamWallMaxLiveLimit';

function cachedLimit(): number {
  try {
    const n = Number(localStorage.getItem(CACHE_KEY));
    return inRange(n, MAX_LIVE_LIMIT_RANGE) ? n : CAM_WALL_DEFAULTS.max_live_limit;
  } catch {
    return CAM_WALL_DEFAULTS.max_live_limit;
  }
}

// A module store rather than a query: CameraWall and CamWallPage are upstream's,
// and their tests render them without the fork's settings.
let maxLiveLimit = cachedLimit();
const listeners = new Set<() => void>();

export function applyCamWall(raw: unknown): void {
  const next = normalizeCamWall(raw).max_live_limit;
  try {
    localStorage.setItem(CACHE_KEY, String(next));
  } catch {
    // Private mode: the limit just isn't remembered.
  }
  if (next === maxLiveLimit) return;
  maxLiveLimit = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => maxLiveLimit;

/** The most live streams the cam wall allows. */
export function useHyyz17200MaxLiveLimit(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
