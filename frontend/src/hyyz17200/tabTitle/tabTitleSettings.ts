/** The Enhanced Settings' tab title section. Mirrors TabTitleSettings in
 *  backend/app/hyyz17200/tab_title.py, defaults included. */

export const COUNT_KEYS = ['printing', 'paused', 'finished', 'idle', 'error', 'offline', 'total'] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export type StateCounts = Record<CountKey, number>;

export interface TabTitleItem {
  key: CountKey;
  /** Shown right before the number; empty shows the bare number. */
  label: string;
}

export interface TabTitleSettings {
  enabled: boolean;
  items: TabTitleItem[];
  hide_zero: boolean;
  show_app_name: boolean;
}

export const LABEL_MAX = 12;

export const DEFAULT_LABELS: Record<CountKey, string> = {
  printing: '▶',
  paused: '⏸',
  finished: '✓',
  idle: '○',
  error: '⚠',
  offline: '✕',
  total: 'Σ',
};

const DEFAULT_KEYS: CountKey[] = ['printing', 'paused', 'finished', 'error', 'offline'];

export const TAB_TITLE_DEFAULTS: TabTitleSettings = {
  enabled: false,
  items: DEFAULT_KEYS.map((key) => ({ key, label: DEFAULT_LABELS[key] })),
  hide_zero: false,
  show_app_name: true,
};

/** The upstream i18n key naming each count, as the printer page's status bar
 *  and bulk toolbar word them. `total` is the fork's. */
export const COUNT_NAME_KEYS: Record<CountKey, string> = {
  printing: 'printers.status.printing',
  paused: 'printers.status.paused',
  finished: 'printers.status.finished',
  idle: 'printers.status.idle',
  error: 'printers.status.problem',
  offline: 'printers.status.offline',
  total: 'hyyz17200.tabTitle.total',
};

const isKey = (value: unknown): value is CountKey => COUNT_KEYS.includes(value as CountKey);

/** Anything malformed falls back to the default, field by field; bad or repeated
 *  items are dropped. */
export function normalizeTabTitle(raw: unknown): TabTitleSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let items = TAB_TITLE_DEFAULTS.items;
  if (Array.isArray(value.items)) {
    const seen = new Set<CountKey>();
    items = [];
    for (const entry of value.items as unknown[]) {
      const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      if (!isKey(item.key) || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push({ key: item.key, label: typeof item.label === 'string' ? item.label.slice(0, LABEL_MAX) : '' });
    }
  }
  return {
    enabled: value.enabled === true,
    items,
    hide_zero: value.hide_zero === true,
    show_app_name: value.show_app_name !== false,
  };
}

/** "▶12 ⏸1 ✓5 · Bambuddy". With every count hidden, just the app name. */
export function formatTabTitle(settings: TabTitleSettings, counts: StateCounts, appName: string): string {
  const parts = settings.items
    .filter((item) => !settings.hide_zero || counts[item.key] > 0)
    .map((item) => `${item.label}${counts[item.key]}`);
  if (parts.length === 0) return appName;
  const text = parts.join(' ');
  return settings.show_app_name ? `${text} · ${appName}` : text;
}
