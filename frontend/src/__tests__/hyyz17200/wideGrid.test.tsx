import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { camWallGridClasses } from '../../components/camWallTileSize';
import { EnhancedSettingsSync } from '../../hyyz17200/EnhancedSettingsSync';
import { WideGridSection } from '../../hyyz17200/WideGridSection';
import {
  WIDE_GRID_DEFAULTS,
  applyWideGrid,
  hyyz17200WideGrid,
  normalizeWideGrid,
  type WideGridSettings,
} from '../../hyyz17200/wideGrid';

const URL = '/api/v1/hyyz17200/settings';
const root = document.documentElement;
const rootVar = (name: string) => root.style.getPropertyValue(`--hyyz17200-${name}`);

let stored: WideGridSettings = WIDE_GRID_DEFAULTS;
const saved = vi.fn();

beforeEach(() => {
  stored = WIDE_GRID_DEFAULTS;
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ wide_grid: stored })),
    http.put(`${URL}/wide_grid`, async ({ request }) => {
      stored = (await request.json()) as WideGridSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => {
  applyWideGrid(WIDE_GRID_DEFAULTS);
  cleanup();
});

describe('wide grid settings', () => {
  it('falls back to the default field by field', () => {
    expect(normalizeWideGrid(null)).toEqual(WIDE_GRID_DEFAULTS);
    expect(
      normalizeWideGrid({
        enabled: false,
        printer_s: { max_columns: 10, min_width: 5, phone_columns: 9 },
        printer_m: 'nope',
        camwall_s: { max_columns: 8, min_width: 220, phone_columns: 3 },
      }),
    ).toEqual({
      ...WIDE_GRID_DEFAULTS,
      enabled: false,
      printer_s: { max_columns: 10, min_width: WIDE_GRID_DEFAULTS.printer_s.min_width, phone_columns: 1 },
      camwall_s: { max_columns: 8, min_width: 220, phone_columns: 3 },
    });
  });

  it('sets the grid variables on <html> as soon as it loads', () => {
    expect(root.dataset.hyyz17200WideGrid).toBe('on');
    expect(rootVar('printer-s-max')).toBe('8');
    expect(rootVar('printer-m-min')).toBe('340px');
    expect(rootVar('printer-s-phone')).toBe('1');
  });

  it('phones default to one per row everywhere, which is upstream', () => {
    for (const key of ['printer_s', 'printer_m', 'printer_l', 'printer_xl', 'camwall_s', 'camwall_m', 'camwall_l', 'camwall_xl'] as const) {
      expect(WIDE_GRID_DEFAULTS[key].phone_columns).toBe(1);
    }
  });

  it('sets the phone column count, even with the wide screen switch off', () => {
    applyWideGrid({
      ...WIDE_GRID_DEFAULTS,
      enabled: false,
      printer_s: { ...WIDE_GRID_DEFAULTS.printer_s, phone_columns: 2 },
      camwall_m: { ...WIDE_GRID_DEFAULTS.camwall_m, phone_columns: 3 },
    });

    expect(root.dataset.hyyz17200WideGrid).toBe('off');
    expect(rootVar('printer-s-phone')).toBe('2');
    expect(rootVar('camwall-m-phone')).toBe('3');
    expect(rootVar('printer-xl-phone')).toBe('1');
  });

  it('applies and remembers new settings', () => {
    applyWideGrid({ ...WIDE_GRID_DEFAULTS, enabled: false, camwall_m: { max_columns: 7, min_width: 300, phone_columns: 2 } });

    expect(root.dataset.hyyz17200WideGrid).toBe('off');
    expect(rootVar('camwall-m-max')).toBe('7');
    expect(rootVar('camwall-m-min')).toBe('300px');
    const [, cached] = vi.mocked(localStorage.setItem).mock.calls.findLast(([key]) => key === 'hyyz17200WideGrid')!;
    expect(JSON.parse(cached).camwall_m).toEqual({ max_columns: 7, min_width: 300, phone_columns: 2 });
  });

  it('widens every camera wall size, keeping upstream classes', () => {
    expect(camWallGridClasses(1)).toContain(`xl:grid-cols-5 ${hyyz17200WideGrid.camwallS}`);
    expect(camWallGridClasses(2)).toContain(`xl:grid-cols-4 ${hyyz17200WideGrid.camwallM}`);
    expect(camWallGridClasses(3)).toBe(`grid-cols-1 lg:grid-cols-2 ${hyyz17200WideGrid.camwallL}`);
    expect(camWallGridClasses(4)).toBe(`grid-cols-1 ${hyyz17200WideGrid.camwallXL}`);
  });

  it('L and XL default to upstream column counts, and their variables are set', () => {
    expect(WIDE_GRID_DEFAULTS.printer_l.max_columns).toBe(2);
    expect(WIDE_GRID_DEFAULTS.printer_xl.max_columns).toBe(1);
    expect(WIDE_GRID_DEFAULTS.camwall_l.max_columns).toBe(2);
    expect(WIDE_GRID_DEFAULTS.camwall_xl.max_columns).toBe(1);
    applyWideGrid({ ...WIDE_GRID_DEFAULTS, printer_xl: { max_columns: 3, min_width: 700, phone_columns: 1 } });
    expect(rootVar('printer-xl-max')).toBe('3');
    expect(rootVar('printer-xl-min')).toBe('700px');
    expect(rootVar('camwall-l-max')).toBe('2');
  });

  it('the sync applies the stored settings', async () => {
    stored = { ...WIDE_GRID_DEFAULTS, printer_m: { max_columns: 5, min_width: 400, phone_columns: 2 } };
    render(<EnhancedSettingsSync />);

    await waitFor(() => expect(rootVar('printer-m-max')).toBe('5'));
    expect(rootVar('printer-m-min')).toBe('400px');
    expect(rootVar('printer-m-phone')).toBe('2');
  });
});

describe('WideGridSection', () => {
  it('saves the per-row count for phones', async () => {
    const user = userEvent.setup();
    render(
      <>
        <EnhancedSettingsSync />
        <WideGridSection />
      </>,
    );

    const field = await screen.findByLabelText('Printer cards, S Per row on phones');
    expect((field as HTMLInputElement).value).toBe('1');
    await user.clear(field);
    await user.type(field, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        ...WIDE_GRID_DEFAULTS,
        printer_s: { ...WIDE_GRID_DEFAULTS.printer_s, phone_columns: 2 },
      }),
    );
    await waitFor(() => expect(rootVar('printer-s-phone')).toBe('2'));
  });

  it('saves an edited limit and applies it at once', async () => {
    const user = userEvent.setup();
    render(
      <>
        <EnhancedSettingsSync />
        <WideGridSection />
      </>,
    );

    const field = await screen.findByLabelText('Printer cards, S Most per row');
    expect((field as HTMLInputElement).value).toBe('8');
    await user.clear(field);
    await user.type(field, '10');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        ...WIDE_GRID_DEFAULTS,
        printer_s: { max_columns: 10, min_width: 220, phone_columns: 1 },
      }),
    );
    await waitFor(() => expect(rootVar('printer-s-max')).toBe('10'));
  });

  it('turning it off disables the limits, and defaults can be restored', async () => {
    const user = userEvent.setup();
    stored = { ...WIDE_GRID_DEFAULTS, printer_m: { max_columns: 4, min_width: 500, phone_columns: 2 } };
    render(<WideGridSection />);

    await user.click(await screen.findByRole('switch'));
    expect((screen.getByLabelText('Printer cards, M Most per row') as HTMLInputElement).disabled).toBe(true);
    // Phones are not under the wide screen switch.
    expect((screen.getByLabelText('Printer cards, M Per row on phones') as HTMLInputElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith(WIDE_GRID_DEFAULTS));
  });
});
