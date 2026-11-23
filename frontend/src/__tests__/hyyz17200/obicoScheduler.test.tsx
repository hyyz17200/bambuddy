import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ObicoSchedulerSection } from '../../hyyz17200/obicoScheduler/ObicoSchedulerSection';
import {
  OBICO_SCHEDULER_DEFAULTS,
  normalizeObicoScheduler,
  targetPerMinute,
  type ObicoSchedulerRow,
  type ObicoSchedulerSettings,
  type ObicoSchedulerStatus,
} from '../../hyyz17200/obicoScheduler/obicoScheduler';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

let stored: ObicoSchedulerSettings = OBICO_SCHEDULER_DEFAULTS;
const saved = vi.fn();

const row = (printer_id: number, name: string, extra: Partial<ObicoSchedulerRow> = {}): ObicoSchedulerRow => ({
  printer_id,
  name,
  printing: true,
  in_flight: false,
  checks: 20,
  ok: 20,
  failed: 0,
  consecutive_failures: 0,
  overruns: 0,
  waits: 1,
  dropped_actions: 0,
  period: 5.02,
  ok_period: 5.04,
  last_ok_age: 2.4,
  next_in: 2.6,
  lag: 0.01,
  capture: 2.91,
  ml: 0.12,
  total: 3.03,
  capture_avg: 2.95,
  ml_avg: 0.11,
  total_avg: 3.06,
  ...extra,
});

let status: ObicoSchedulerStatus;

beforeEach(() => {
  stored = OBICO_SCHEDULER_DEFAULTS;
  saved.mockClear();
  status = {
    mode: 'concurrent',
    max_concurrent: 8,
    skip_preparation: true,
    preparing: 2,
    in_flight: 3,
    interval: 5,
    checks_last_minute: 24,
    ok_last_minute: 23,
    printers: [
      row(2, 'A1-010'),
      row(1, 'A1-002', { consecutive_failures: 3, last_ok_age: 40 }),
      row(3, 'A1-003', { printing: false }),
    ],
  };
  server.use(
    http.get('/api/v1/hyyz17200/obico/scheduler', () => HttpResponse.json(status)),
    http.get(URL, () => HttpResponse.json({ obico: stored })),
    http.put(`${URL}/obico`, async ({ request }) => {
      stored = (await request.json()) as ObicoSchedulerSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('AI detection scheduling settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('ai-detection');
  });

  it('falls back to the default field by field', () => {
    expect(normalizeObicoScheduler(undefined)).toEqual(OBICO_SCHEDULER_DEFAULTS);
    expect(normalizeObicoScheduler({ enabled: 'no', max_concurrent: 0, skip_preparation: 1 })).toEqual(
      OBICO_SCHEDULER_DEFAULTS,
    );
    expect(normalizeObicoScheduler({ enabled: false, max_concurrent: 33 })).toEqual({
      enabled: false,
      max_concurrent: 8,
      skip_preparation: true,
    });
    expect(normalizeObicoScheduler({ enabled: true, max_concurrent: 16, skip_preparation: false })).toEqual({
      enabled: true,
      max_concurrent: 16,
      skip_preparation: false,
    });
  });

  it('starts side by side, and saves another limit', async () => {
    const user = userEvent.setup();
    render(<ObicoSchedulerSection />);

    const [toggle, firstLayer] = await screen.findAllByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(firstLayer.getAttribute('aria-checked')).toBe('true');
    const field = screen.getByLabelText('Checks at once') as HTMLInputElement;
    expect(field.value).toBe('8');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(field);
    await user.type(field, '16');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ enabled: true, max_concurrent: 16, skip_preparation: true }),
    );
  });

  it('can check from the start of the start sequence again', async () => {
    const user = userEvent.setup();
    render(<ObicoSchedulerSection />);
    const [, firstLayer] = await screen.findAllByRole('switch');
    await user.click(firstLayer);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ enabled: true, max_concurrent: 8, skip_preparation: false }),
    );
  });

  it("can go back to upstream's loop, which has no limit to set", async () => {
    const user = userEvent.setup();
    render(<ObicoSchedulerSection />);
    await user.click((await screen.findAllByRole('switch'))[0]);
    expect((screen.getByLabelText('Checks at once') as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ enabled: false, max_concurrent: 8, skip_preparation: true }),
    );
  });

  it('lists the printing printers by name with their numbers', async () => {
    render(<ObicoSchedulerSection />);
    const table = await screen.findByRole('table');
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.querySelector('td')?.textContent);
    expect(names).toEqual(['A1-002', 'A1-010']);

    const ok = table.querySelector('[data-printer="2"]') as HTMLElement;
    expect(ok.textContent).toContain('5.0 s');
    expect(ok.textContent).toContain('2.95 s');
    expect(ok.textContent).toContain('0.11 s');
    expect(ok.textContent).toContain('2 s ago');
    const failing = table.querySelector('[data-printer="1"]') as HTMLElement;
    expect(failing.textContent).toContain('3 failed in a row');

    expect(screen.getByText(/3 of up to 8 running now/)).toBeTruthy();
    expect(screen.getByText(/24 needed for 2 printers every 5 s/)).toBeTruthy();
    expect(screen.getByText(/2 before layer 1, not checked yet/)).toBeTruthy();
  });

  it('shows the printers that are not printing on request', async () => {
    const user = userEvent.setup();
    render(<ObicoSchedulerSection />);
    await user.click(await screen.findByRole('button', { name: 'Show all 3 printers seen' }));
    expect(screen.getByText('A1-003')).toBeTruthy();
  });

  it('works out the checks a minute every printer needs', () => {
    expect(targetPerMinute(status)).toBe(24);
    expect(targetPerMinute({ ...status, interval: null })).toBeNull();
  });
});
