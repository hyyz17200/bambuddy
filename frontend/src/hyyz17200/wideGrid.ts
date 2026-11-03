import './wideGrid.css';

/** One grid's limits: at most `max_columns` per row, each at least `min_width`
 *  CSS pixels wide. Mirrors backend/app/hyyz17200/wide_grid.py. */
export interface GridLimit {
  max_columns: number;
  min_width: number;
}

export const WIDE_GRID_KEYS = [
  'printer_s',
  'printer_m',
  'printer_l',
  'printer_xl',
  'camwall_s',
  'camwall_m',
  'camwall_l',
  'camwall_xl',
] as const;

export type WideGridKey = (typeof WIDE_GRID_KEYS)[number];

export type WideGridSettings = { enabled: boolean } & Record<WideGridKey, GridLimit>;

// L and XL default to upstream's own 2 and 1 per row, so they change nothing
// until raised.
export const WIDE_GRID_DEFAULTS: WideGridSettings = {
  enabled: true,
  printer_s: { max_columns: 8, min_width: 220 },
  printer_m: { max_columns: 6, min_width: 340 },
  printer_l: { max_columns: 2, min_width: 520 },
  printer_xl: { max_columns: 1, min_width: 800 },
  camwall_s: { max_columns: 8, min_width: 220 },
  camwall_m: { max_columns: 6, min_width: 280 },
  camwall_l: { max_columns: 2, min_width: 480 },
  camwall_xl: { max_columns: 1, min_width: 800 },
};

export const MAX_COLUMNS_RANGE = { min: 1, max: 16 };
export const MIN_WIDTH_RANGE = { min: 120, max: 1200 };

/** Appended to upstream's grid classes: PrintersPage for the cards,
 *  camWallTileSize for the camera wall tiles. */
export const hyyz17200WideGrid = {
  printerS: 'hyyz17200-wide-grid hyyz17200-grid-printer-s',
  printerM: 'hyyz17200-wide-grid hyyz17200-grid-printer-m',
  printerL: 'hyyz17200-wide-grid hyyz17200-grid-printer-l',
  printerXL: 'hyyz17200-wide-grid hyyz17200-grid-printer-xl',
  camwallS: 'hyyz17200-wide-grid hyyz17200-grid-camwall-s',
  camwallM: 'hyyz17200-wide-grid hyyz17200-grid-camwall-m',
  camwallL: 'hyyz17200-wide-grid hyyz17200-grid-camwall-l',
  camwallXL: 'hyyz17200-wide-grid hyyz17200-grid-camwall-xl',
};

// The last settings seen, so a reload lays the grid out right before the
// settings arrive, and a kiosk camera wall that cannot fetch them uses this
// browser's.
const CACHE_KEY = 'hyyz17200WideGrid';

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;

/** Anything malformed or missing falls back to the default, field by field. */
export function normalizeWideGrid(raw: unknown): WideGridSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const settings: WideGridSettings = {
    ...WIDE_GRID_DEFAULTS,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : WIDE_GRID_DEFAULTS.enabled,
  };
  for (const key of WIDE_GRID_KEYS) {
    const grid = (source[key] && typeof source[key] === 'object' ? source[key] : {}) as Record<string, unknown>;
    settings[key] = {
      max_columns: inRange(grid.max_columns, MAX_COLUMNS_RANGE) ? grid.max_columns : WIDE_GRID_DEFAULTS[key].max_columns,
      min_width: inRange(grid.min_width, MIN_WIDTH_RANGE) ? grid.min_width : WIDE_GRID_DEFAULTS[key].min_width,
    };
  }
  return settings;
}

function apply(settings: WideGridSettings): void {
  const root = document.documentElement;
  root.dataset.hyyz17200WideGrid = settings.enabled ? 'on' : 'off';
  for (const key of WIDE_GRID_KEYS) {
    const name = key.replace('_', '-');
    root.style.setProperty(`--hyyz17200-${name}-max`, String(settings[key].max_columns));
    root.style.setProperty(`--hyyz17200-${name}-min`, `${settings[key].min_width}px`);
  }
}

/** Lay the grids out with these settings, and remember them for the next load. */
export function applyWideGrid(raw: unknown): void {
  const settings = normalizeWideGrid(raw);
  apply(settings);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or quota: the grid still applies, it just isn't cached.
  }
}

function readCache(): unknown {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

// Without the variables the grid rule would be invalid and collapse to one
// column, so they are set the moment any grid can use the classes.
apply(normalizeWideGrid(readCache()));
