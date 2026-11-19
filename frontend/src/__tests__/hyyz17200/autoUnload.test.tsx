import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { AutoUnloadSection } from '../../hyyz17200/AutoUnloadSection';
import {
  AUTO_UNLOAD_DEFAULTS,
  normalizeAutoUnload,
  type AutoUnloadSettings,
} from '../../hyyz17200/autoUnloadSettings';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';
import { sortRows, viewOf, type AutoUnloadRow, type AutoUnloadStatus } from '../../hyyz17200/autoUnloadApi';

const URL = '/api/v1/hyyz17200/settings';

let stored: AutoUnloadSettings = AUTO_UNLOAD_DEFAULTS;
const saved = vi.fn();

const row = (printer_id: number, name: string, extra: Partial<AutoUnloadRow> = {}): AutoUnloadRow => ({
  printer_id,
  name,
  model: 'A1',
  is_active: true,
  state: 'FINISH',
  tray_now: 1,
  ams_status_main: 3,
  idle_seconds: 600,
  reason: null,
  tried: false,
  unloading: false,
  ...extra,
});

let farm: AutoUnloadStatus = { enabled: true, idle_minutes: 15, printers: [] };

beforeEach(() => {
  stored = AUTO_UNLOAD_DEFAULTS;
  saved.mockClear();
  farm = { enabled: true, idle_minutes: 15, printers: [] };
  server.use(
    http.get('/api/v1/hyyz17200/auto-unload/status', () => HttpResponse.json(farm)),
    http.get(URL, () => HttpResponse.json({ auto_unload: stored })),
    http.put(`${URL}/auto_unload`, async ({ request }) => {
      stored = (await request.json()) as AutoUnloadSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('auto unload settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('auto-unload');
  });

  it('falls back to the default field by field', () => {
    expect(normalizeAutoUnload(null)).toEqual(AUTO_UNLOAD_DEFAULTS);
    expect(normalizeAutoUnload({ enabled: 'yes', idle_minutes: 4 })).toEqual(AUTO_UNLOAD_DEFAULTS);
    expect(normalizeAutoUnload({ enabled: true, idle_minutes: 721 })).toEqual({ enabled: true, idle_minutes: 30 });
    expect(normalizeAutoUnload({ enabled: true, idle_minutes: 90 })).toEqual({ enabled: true, idle_minutes: 90 });
  });

  it('starts off, and saves it turned on with another idle time', async () => {
    const user = userEvent.setup();
    render(<AutoUnloadSection />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const field = screen.getByLabelText('Idle minutes') as HTMLInputElement;
    expect(field.value).toBe('30');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(toggle);
    await user.clear(field);
    await user.type(field, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ enabled: true, idle_minutes: 45 }));
  });

  it('shows what was saved', async () => {
    stored = { enabled: true, idle_minutes: 120 };
    render(<AutoUnloadSection />);

    expect((await screen.findByRole('switch')).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Idle minutes') as HTMLInputElement).value).toBe('120');
  });
});

describe('auto unload printers table', () => {
  it('sorts problems first, then by name with numbers in order', () => {
    const rows = sortRows([
      row(3, 'A1-10'),
      row(1, 'A1-9'),
      row(2, 'A1-2', { reason: 'nothing_loaded', tray_now: 255 }),
      row(4, 'A1-1', { reason: 'fault' }),
      row(5, 'A1-3', { unloading: true }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['A1-1', 'A1-3', 'A1-9', 'A1-10', 'A1-2']);
  });

  it('tells the groups apart', () => {
    expect(viewOf(row(1, 'a'))).toEqual({ group: 'waiting', key: 'waiting' });
    expect(viewOf(row(1, 'a', { tried: true }))).toEqual({ group: 'attention', key: 'tried' });
    expect(viewOf(row(1, 'a', { reason: 'ams_busy' }))).toEqual({ group: 'attention', key: 'ams_busy' });
    expect(viewOf(row(1, 'a', { reason: 'external_spool' }))).toEqual({ group: 'quiet', key: 'external_spool' });
    const unseen = { printer_id: 1, name: 'a', model: 'A1', is_active: true };
    expect(viewOf(unseen)).toEqual({ group: 'quiet', key: 'offline' });
    expect(viewOf({ ...unseen, is_active: false })).toEqual({ group: 'quiet', key: 'maintenance' });
  });

  it('says why each printer is not unloaded, hiding the ones with nothing to do', async () => {
    const user = userEvent.setup();
    farm.printers = [
      row(9, 'A1-014', { reason: 'ams_busy', ams_status_main: 1 }),
      row(10, 'A1-015', { idle_seconds: 300 }),
      row(39, 'A1-022', {
        reason: 'nothing_loaded',
        tray_now: 255,
        tried: true,
        last: { result: 'unloaded', detail: '100 s, 250 °C', at: '2026-11-20T04:26:57+00:00' },
      }),
    ];
    render(<AutoUnloadSection />);

    expect(await screen.findByText('AMS busy (status 1)')).toBeTruthy();
    expect(screen.getByText('Waiting for the idle time')).toBeTruthy();
    expect(screen.getByText('5 / 15 min')).toBeTruthy();
    expect(screen.queryByText('A1-022')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show all 3 printers' }));
    expect(screen.getByText('Nothing loaded')).toBeTruthy();
    expect(screen.getByText(/Unloaded \(100 s, 250 °C\)/)).toBeTruthy();
  });

  it('says when auto unload is off', async () => {
    farm = { enabled: false, idle_minutes: 30, printers: [] };
    render(<AutoUnloadSection />);

    expect(await screen.findByText('Auto unload is off.')).toBeTruthy();
  });
});
