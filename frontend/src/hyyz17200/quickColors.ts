import { useMemo, useSyncExternalStore } from 'react';

/** One quick colour swatch. Mirrors backend/app/hyyz17200/quick_colors.py. */
export interface QuickColor {
  name: string;
  hex: string;
}

export interface QuickColorSettings {
  customized: boolean;
  basic: QuickColor[];
  extended: QuickColor[];
}

export const QUICK_COLOR_LIMITS = { basic: 32, extended: 64, name: 40 };

// The AMS dialog's upstream lists: where the editor starts. Kept in step with
// quick_colors.py.
export const QUICK_COLOR_DEFAULTS: QuickColorSettings = {
  customized: false,
  basic: [
    { name: 'White', hex: 'FFFFFF' },
    { name: 'Black', hex: '000000' },
    { name: 'Red', hex: 'FF0000' },
    { name: 'Blue', hex: '0000FF' },
    { name: 'Green', hex: '00AA00' },
    { name: 'Yellow', hex: 'FFFF00' },
    { name: 'Orange', hex: 'FFA500' },
    { name: 'Gray', hex: '808080' },
  ],
  extended: [
    { name: 'Cyan', hex: '00FFFF' },
    { name: 'Magenta', hex: 'FF00FF' },
    { name: 'Purple', hex: '800080' },
    { name: 'Pink', hex: 'FFC0CB' },
    { name: 'Brown', hex: '8B4513' },
    { name: 'Beige', hex: 'F5F5DC' },
    { name: 'Navy', hex: '000080' },
    { name: 'Teal', hex: '008080' },
    { name: 'Lime', hex: '32CD32' },
    { name: 'Gold', hex: 'FFD700' },
    { name: 'Silver', hex: 'C0C0C0' },
    { name: 'Maroon', hex: '800000' },
    { name: 'Olive', hex: '808000' },
    { name: 'Coral', hex: 'FF7F50' },
    { name: 'Salmon', hex: 'FA8072' },
    { name: 'Turquoise', hex: '40E0D0' },
    { name: 'Violet', hex: 'EE82EE' },
    { name: 'Indigo', hex: '4B0082' },
    { name: 'Chocolate', hex: 'D2691E' },
    { name: 'Tan', hex: 'D2B48C' },
    { name: 'Slate', hex: '708090' },
    { name: 'Charcoal', hex: '36454F' },
    { name: 'Ivory', hex: 'FFFFF0' },
    { name: 'Cream', hex: 'FFFDD0' },
  ],
};

export const isHex6 = (value: string) => /^[0-9A-Fa-f]{6}$/.test(value);

function normalizeList(raw: unknown): QuickColor[] | null {
  if (!Array.isArray(raw)) return null;
  const colors: QuickColor[] = [];
  for (const item of raw) {
    const { name, hex } = (item ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || typeof hex !== 'string' || !isHex6(hex)) return null;
    colors.push({ name: name.trim(), hex: hex.toUpperCase() });
  }
  return colors;
}

/** Malformed lists fall back to the defaults. Anything off means upstream's. */
export function normalizeQuickColors(raw: unknown): QuickColorSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const basic = normalizeList(source.basic);
  const extended = normalizeList(source.extended);
  return {
    customized: source.customized === true && basic !== null && extended !== null,
    basic: basic ?? QUICK_COLOR_DEFAULTS.basic,
    extended: extended ?? QUICK_COLOR_DEFAULTS.extended,
  };
}

// The settings the dialogs draw from. EnhancedSettingsSync feeds it on every
// page, so the dialogs need no query of their own (and no providers, which
// upstream's tests of them don't always set up).
let current: QuickColorSettings = QUICK_COLOR_DEFAULTS;
const listeners = new Set<() => void>();

export function applyQuickColors(raw: unknown): void {
  const next = normalizeQuickColors(raw);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

/** The swatches a dialog shows: the saved ones once customized, else the
 *  dialog's own upstream lists. Upstream swatches that carry an alpha byte
 *  (the spool form's transparent "Clear") are not colours and always stay,
 *  at the end of the basic row. */
export function useHyyz17200QuickColors<T extends QuickColor>(
  upstreamBasic: T[],
  upstreamExtended: T[],
): { basic: QuickColor[]; extended: QuickColor[] } {
  const settings = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    if (!settings.customized) return { basic: upstreamBasic, extended: upstreamExtended };
    const kept = upstreamBasic.filter((color) => color.hex.length === 8);
    return { basic: [...settings.basic, ...kept], extended: settings.extended };
  }, [settings, upstreamBasic, upstreamExtended]);
}
