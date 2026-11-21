import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import type { HMSError } from '../../api/client';
import { setHiddenCodes } from '../../hyyz17200/hiddenFaults';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';
import { countPrinterStates, type CountedStatus } from '../../hyyz17200/tabTitle/counts';
import { APP_TITLE, setOwnedTitle } from '../../hyyz17200/tabTitle/ownTitle';
import { TabTitleSection } from '../../hyyz17200/tabTitle/TabTitleSection';
import { TabTitleSync } from '../../hyyz17200/tabTitle/TabTitleSync';
import {
  TAB_TITLE_DEFAULTS,
  formatTabTitle,
  normalizeTabTitle,
  type StateCounts,
  type TabTitleSettings,
} from '../../hyyz17200/tabTitle/tabTitleSettings';

const URL = '/api/v1/hyyz17200/settings';

const fault = (full_code: string): HMSError =>
  ({ code: full_code, full_code, attr: 0, module: 3, severity: 2, description: 'Something is wrong' }) as HMSError;

const status = (state: string | null, extra: Partial<CountedStatus> = {}): CountedStatus => ({
  connected: true,
  state,
  hms_errors: [],
  ...extra,
});

const COUNTS: StateCounts = { printing: 12, paused: 1, finished: 5, idle: 3, error: 2, offline: 0, total: 23 };

afterEach(() => {
  cleanup();
  setOwnedTitle(null);
  setHiddenCodes([]);
});

describe('tab title settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('tab-title');
  });

  it('falls back to the defaults field by field and drops bad or repeated items', () => {
    expect(normalizeTabTitle(null)).toEqual(TAB_TITLE_DEFAULTS);
    expect(
      normalizeTabTitle({
        enabled: true,
        items: [{ key: 'offline', label: 'OFF' }, { key: 'nope' }, { key: 'offline', label: 'x' }, { key: 'total' }],
        hide_zero: 'yes',
        show_app_name: false,
      }),
    ).toEqual({
      enabled: true,
      items: [{ key: 'offline', label: 'OFF' }, { key: 'total', label: '' }],
      hide_zero: false,
      show_app_name: false,
    });
  });

  it('writes the counts in order, label first', () => {
    const settings: TabTitleSettings = {
      ...TAB_TITLE_DEFAULTS,
      items: [
        { key: 'error', label: '⚠' },
        { key: 'printing', label: 'P' },
        { key: 'offline', label: '' },
      ],
    };
    expect(formatTabTitle(settings, COUNTS, 'Bambuddy')).toBe('⚠2 P12 0 · Bambuddy');
    expect(formatTabTitle({ ...settings, hide_zero: true }, COUNTS, 'Bambuddy')).toBe('⚠2 P12 · Bambuddy');
    expect(formatTabTitle({ ...settings, show_app_name: false }, COUNTS, 'Bambuddy')).toBe('⚠2 P12 0');
    expect(formatTabTitle({ ...settings, items: [] }, COUNTS, 'Bambuddy')).toBe('Bambuddy');
  });
});

describe('counting', () => {
  it('follows the printer page status bar', () => {
    const counts = countPrinterStates([
      status('RUNNING'),
      status('RUNNING', { hms_errors: [fault('0300_0001')] }),
      status('PAUSE'),
      status('FINISH'),
      status('FAILED'),
      status('FAILED', { hms_errors: [fault('0300_0002')] }),
      status('IDLE'),
      status(null),
      status('RUNNING', { connected: false }),
      undefined,
    ]);
    expect(counts).toEqual({ printing: 2, paused: 1, finished: 2, idle: 2, error: 2, offline: 1, total: 10 });
  });

  it('leaves out hidden faults', () => {
    setHiddenCodes(['0300_0001']);
    expect(countPrinterStates([status('IDLE', { hms_errors: [fault('0300_0001')] })]).error).toBe(0);
  });
});

describe('owning the title', () => {
  it('puts its text back after another write and hands the tab back when off', async () => {
    document.title = 'Bambuddy';
    setOwnedTitle('▶3 · Bambuddy');
    expect(document.title).toBe('▶3 · Bambuddy');

    // What upstream's progress hook does on its own schedule.
    document.title = '42% · Bambuddy';
    await waitFor(() => expect(document.title).toBe('▶3 · Bambuddy'));

    setOwnedTitle(null);
    expect(document.title).toBe(APP_TITLE);
    document.title = '42% · Bambuddy';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.title).toBe('42% · Bambuddy');
  });
});

describe('TabTitleSync', () => {
  let tabTitle: unknown;
  const printerRequests = vi.fn();

  beforeEach(() => {
    document.title = 'Bambuddy';
    printerRequests.mockClear();
    const states: Record<string, CountedStatus> = {
      '1': status('RUNNING'),
      '2': status('RUNNING'),
      '3': status('IDLE', { connected: false }),
    };
    server.use(
      http.get(URL, () => HttpResponse.json({ tab_title: tabTitle })),
      http.get('/api/v1/printers/', () => {
        printerRequests();
        return HttpResponse.json(Object.keys(states).map((id) => ({ id: Number(id), name: `P${id}` })));
      }),
      http.get('/api/v1/printers/:id/status', ({ params }) =>
        HttpResponse.json({ id: Number(params.id), ...states[params.id as string] }),
      ),
    );
  });

  it('shows the counts while on', async () => {
    tabTitle = {
      ...TAB_TITLE_DEFAULTS,
      enabled: true,
      items: [
        { key: 'printing', label: '▶' },
        { key: 'offline', label: '✕' },
      ],
    };
    render(<TabTitleSync />);
    await waitFor(() => expect(document.title).toBe(`▶2 ✕1 · ${APP_TITLE}`));
  });

  it('does nothing while off', async () => {
    tabTitle = { ...TAB_TITLE_DEFAULTS, enabled: false };
    render(<TabTitleSync />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(printerRequests).not.toHaveBeenCalled();
    expect(document.title).toBe('Bambuddy');
  });
});

describe('TabTitleSection', () => {
  let stored: TabTitleSettings;
  const saved = vi.fn();

  beforeEach(() => {
    stored = TAB_TITLE_DEFAULTS;
    saved.mockClear();
    server.use(
      http.get(URL, () => HttpResponse.json({ tab_title: stored })),
      http.put(`${URL}/tab_title`, async ({ request }) => {
        stored = (await request.json()) as TabTitleSettings;
        saved(stored);
        return HttpResponse.json(stored);
      }),
    );
  });

  it('turns it on, reorders, relabels, adds and removes counts', async () => {
    const user = userEvent.setup();
    render(<TabTitleSection />);

    await user.click(await screen.findByRole('switch', { name: /Show printer counts/ }));

    // Offline to the front, error out, total in at the end.
    const offline = screen.getByTestId('tab-title-item-offline');
    for (let i = 0; i < 4; i++) await user.click(within(offline).getByRole('button', { name: 'Move up' }));
    await user.click(within(screen.getByTestId('tab-title-item-error')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'All printers' }));
    const label = within(screen.getByTestId('tab-title-item-printing')).getByRole('textbox');
    await user.clear(label);
    await user.type(label, 'P');

    expect(screen.getByTestId('tab-title-preview').textContent).toBe(`✕4 P12 ⏸1 ✓5 Σ25 · ${APP_TITLE}`);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        enabled: true,
        items: [
          { key: 'offline', label: '✕' },
          { key: 'printing', label: 'P' },
          { key: 'paused', label: '⏸' },
          { key: 'finished', label: '✓' },
          { key: 'total', label: 'Σ' },
        ],
        hide_zero: false,
        show_app_name: true,
      }),
    );
  });
});
