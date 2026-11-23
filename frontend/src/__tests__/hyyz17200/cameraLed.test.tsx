import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CameraLedSection } from '../../hyyz17200/cameraLed/CameraLedSection';
import {
  CAMERA_LED_DEFAULTS,
  normalizeCameraLed,
  type CameraLedSettings,
} from '../../hyyz17200/cameraLed/cameraLedSettings';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

let stored: CameraLedSettings = { ...CAMERA_LED_DEFAULTS };
const saved = vi.fn();

beforeEach(() => {
  stored = { ...CAMERA_LED_DEFAULTS };
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ camera_led: stored })),
    http.get('/api/v1/printers/', () =>
      HttpResponse.json([
        { id: 3, name: 'A1-010', model: 'A1' },
        { id: 1, name: 'A1-002', model: 'A1' },
        { id: 2, name: 'P1S-01', model: 'P1S' },
      ]),
    ),
    http.put(`${URL}/camera_led`, async ({ request }) => {
      stored = (await request.json()) as CameraLedSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('auto camera LED settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('camera-led');
  });

  it('falls back to the defaults field by field', () => {
    expect(normalizeCameraLed(null)).toEqual({
      enabled: false,
      obico_force: false,
      off_delay_seconds: 60,
      keep_camera_printer_ids: [],
    });
    expect(
      normalizeCameraLed({
        enabled: 'yes',
        obico_force: true,
        off_delay_seconds: 5000,
        keep_camera_printer_ids: 'x',
      }),
    ).toEqual({
      enabled: false,
      obico_force: true,
      off_delay_seconds: 60,
      keep_camera_printer_ids: [],
    });
    expect(
      normalizeCameraLed({
        enabled: true,
        obico_force: false,
        off_delay_seconds: 0,
        keep_camera_printer_ids: [5, 2, 5, 'a', 1.5],
      }),
    ).toEqual({
      enabled: true,
      obico_force: false,
      off_delay_seconds: 0,
      keep_camera_printer_ids: [2, 5],
    });
  });

  it('starts off and saves both switches', async () => {
    const user = userEvent.setup();
    render(<CameraLedSection />);

    await screen.findByText('On while printing, off when idle');
    const [printing, obico] = screen.getAllByRole('switch');
    expect(printing.getAttribute('aria-checked')).toBe('false');
    expect(obico.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    // The delay only matters once something holds the light.
    expect((screen.getByLabelText('Off after (seconds)') as HTMLInputElement).disabled).toBe(true);

    await user.click(printing);
    await user.click(obico);
    expect((screen.getByLabelText('Off after (seconds)') as HTMLInputElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        enabled: true,
        obico_force: true,
        off_delay_seconds: 60,
        keep_camera_printer_ids: [],
      }),
    );
  });

  it('shows what was saved', async () => {
    stored = {
      enabled: false,
      obico_force: true,
      off_delay_seconds: 120,
      keep_camera_printer_ids: [],
    };
    render(<CameraLedSection />);

    await screen.findByText('Always on while Obico checks');
    const [printing, obico] = screen.getAllByRole('switch');
    expect(printing.getAttribute('aria-checked')).toBe('false');
    expect(obico.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Off after (seconds)') as HTMLInputElement).value).toBe('120');
  });

  it('picks the printers whose camera stays connected', async () => {
    const user = userEvent.setup();
    stored = {
      enabled: true,
      obico_force: false,
      off_delay_seconds: 60,
      keep_camera_printer_ids: [3],
    };
    render(<CameraLedSection />);

    await screen.findByRole('checkbox', { name: /A1-002/ });
    const tenth = screen.getByRole('checkbox', { name: /A1-010/ });
    // Sorted by name, numbers in order.
    const names = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent);
    expect(names).toEqual(['A1-002A1', 'A1-010A1', 'P1S-01P1S']);
    expect((tenth as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('1 selected')).toBeTruthy();

    await user.type(screen.getByLabelText('Filter by name or model'), 'p1s');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Filter by name or model'));

    // The filter re-mounted the rows: find it again.
    await user.click(screen.getByRole('checkbox', { name: /A1-002/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        enabled: true,
        obico_force: false,
        off_delay_seconds: 60,
        keep_camera_printer_ids: [1, 3],
      }),
    );
  });

  it('cannot pick printers while nothing holds the light', async () => {
    render(<CameraLedSection />);
    const box = await screen.findByRole('checkbox', { name: /A1-002/ });
    expect((box as HTMLInputElement).disabled).toBe(true);
  });
});
