import { hyyz17200Request } from './request';

/** Every section of the Enhanced Settings page, keyed by section name, with the
 *  backend's defaults filled in. Each patch that adds a section types its own. */
export type EnhancedSettings = Record<string, unknown>;

export const ENHANCED_SETTINGS_QUERY_KEY = ['hyyz17200', 'settings'];

export async function getEnhancedSettings(): Promise<EnhancedSettings> {
  return (await hyyz17200Request('/settings')).json();
}

/** Replaces one section; fields left out go back to their defaults. */
export async function saveEnhancedSettingsSection<T>(section: string, value: T): Promise<T> {
  return (await hyyz17200Request(`/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) })).json();
}
