import { useSyncExternalStore } from 'react';

/** Mirrors QuickButtonSettings in backend/app/hyyz17200/quick_buttons.py. */
export interface QuickButtonSettings {
  /** Hide upstream's red bug-report button (the PC corner disc and the phone top-bar button). */
  hide_bug_report: boolean;
  /** A Select button for the printer page that stays on screen. */
  select_button: boolean;
}

export const QUICK_BUTTON_DEFAULTS: QuickButtonSettings = { hide_bug_report: false, select_button: false };

/** Off unless saved on, field by field. */
export function normalizeQuickButtons(raw: unknown): QuickButtonSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    hide_bug_report: value.hide_bug_report === true,
    select_button: value.select_button === true,
  };
}

// The last value seen, so a reload does not flash the bug button back for the
// moment before the settings arrive.
const CACHE_KEY = 'hyyz17200QuickButtons';

function cached(): QuickButtonSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? normalizeQuickButtons(JSON.parse(raw)) : QUICK_BUTTON_DEFAULTS;
  } catch {
    return QUICK_BUTTON_DEFAULTS;
  }
}

// A module store rather than a query: Layout and PrintersPage are upstream's,
// and their tests render them without the fork's settings.
let settings = cached();
const listeners = new Set<() => void>();

export function applyQuickButtons(raw: unknown): void {
  const next = normalizeQuickButtons(raw);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Private mode: the value just isn't remembered.
  }
  if (next.hide_bug_report === settings.hide_bug_report && next.select_button === settings.select_button) return;
  settings = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => settings;

export function useHyyz17200QuickButtons(): QuickButtonSettings {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** For Layout: whether upstream's bug-report button is hidden. */
export function useHyyz17200HideBugReport(): boolean {
  return useHyyz17200QuickButtons().hide_bug_report;
}
