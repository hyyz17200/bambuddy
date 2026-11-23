import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CameraLedSection } from '../../hyyz17200/cameraLed/CameraLedSection';
import {
  CAMERA_LED_DEFAULTS,
  keepCameraChoice,
  keepsCamera,
  normalizeCameraLed,
  withKeepCameraChoice,
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
        { id: 3, name: 'A1-010', model: 'A1', location: 'Rack B' },
        { id: 1, name: 'A1-002', model: 'A1', location: 'Rack A' },
        { id: 2, name: 'P1S-01', model: 'P1S', location: 'Rack A' },
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

const on = (overrides: Partial<CameraLedSettings> = {}): CameraLedSettings => ({
  ...CAMERA_LED_DEFAULTS,
  enabled: true,
  ...overrides,
});

function row(name: string) {
  return screen.getByRole('checkbox', { name }).closest('tr') as HTMLElement;
}

describe('auto camera LED settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('camera-led');
  });

  it('falls back to the defaults field by field', () => {
    expect(normalizeCameraLed(null)).toEqual(CAMERA_LED_DEFAULTS);
    expect(
      normalizeCameraLed({ enabled: 'yes', obico_force: true, off_delay_seconds: 5000, keep_camera_printer_ids: 'x' }),
    ).toEqual({ ...CAMERA_LED_DEFAULTS, obico_force: true });
    // A list saved before the global switch existed still reads; on beats off.
    expect(
      normalizeCameraLed({
        enabled: true,
        off_delay_seconds: 0,
        keep_camera_printer_ids: [5, 2, 5, 'a', 1.5],
        keep_camera_off_ids: [2, 7],
      }),
    ).toEqual({
      ...CAMERA_LED_DEFAULTS,
      enabled: true,
      off_delay_seconds: 0,
      keep_camera_printer_ids: [2, 5],
      keep_camera_off_ids: [7],
    });
  });

  it('works out each printer from the global switch and its own setting', () => {
    const value = on({ keep_camera_all: true, keep_camera_printer_ids: [1], keep_camera_off_ids: [2] });
    expect([1, 2, 3].map((id) => keepCameraChoice(value, id))).toEqual(['on', 'off', 'follow']);
    expect([1, 2, 3].map((id) => keepsCamera(value, id))).toEqual([true, false, true]);
    expect(keepsCamera({ ...value, keep_camera_all: false }, 3)).toBe(false);

    const changed = withKeepCameraChoice(value, [1, 3], 'off');
    expect(changed.keep_camera_printer_ids).toEqual([]);
    expect(changed.keep_camera_off_ids).toEqual([1, 2, 3]);
    expect(withKeepCameraChoice(changed, [2], 'follow').keep_camera_off_ids).toEqual([1, 3]);
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
      expect(saved).toHaveBeenCalledWith({ ...CAMERA_LED_DEFAULTS, enabled: true, obico_force: true }),
    );
  });

  it('shows what was saved', async () => {
    stored = { ...CAMERA_LED_DEFAULTS, obico_force: true, off_delay_seconds: 120 };
    render(<CameraLedSection />);

    await screen.findByText('Always on while Obico checks');
    const [printing, obico] = screen.getAllByRole('switch');
    expect(printing.getAttribute('aria-checked')).toBe('false');
    expect(obico.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Off after (seconds)') as HTMLInputElement).value).toBe('120');
  });

  it('lists every printer with its own setting and the result', async () => {
    stored = on({ keep_camera_all: true, keep_camera_off_ids: [2] });
    render(<CameraLedSection />);

    await screen.findByRole('checkbox', { name: 'A1-002' });
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent);
    expect(names).toEqual(['A1-002', 'A1-010', 'P1S-01']);
    expect(within(row('A1-002')).getByText('Kept connected')).toBeTruthy();
    expect(within(row('P1S-01')).getByText('Not kept')).toBeTruthy();
    expect((screen.getByLabelText('Own setting for P1S-01') as HTMLSelectElement).value).toBe('off');
    expect(screen.getByText('2 of 3 printers keep their camera connected.')).toBeTruthy();
  });

  it('sets one printer, a filtered selection and the global switch, then saves', async () => {
    const user = userEvent.setup();
    stored = on();
    render(<CameraLedSection />);
    await screen.findByRole('checkbox', { name: 'A1-002' });

    await user.selectOptions(screen.getByLabelText('Own setting for A1-010'), 'on');
    expect(within(row('A1-010')).getByText('Kept connected')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Location'), 'Rack A');
    expect(screen.queryByRole('checkbox', { name: 'A1-010' })).toBeNull();
    await user.click(screen.getByLabelText('Select all shown'));
    await user.click(screen.getByRole('button', { name: 'Off' }));

    const keepAll = screen.getAllByRole('switch')[2];
    await user.click(keepAll);
    expect(screen.getByText('1 of 3 printers keep their camera connected.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith(
        on({ keep_camera_all: true, keep_camera_printer_ids: [3], keep_camera_off_ids: [1, 2] }),
      ),
    );
  });

  it('cannot change printers while nothing holds the light', async () => {
    render(<CameraLedSection />);
    await screen.findByRole('checkbox', { name: 'A1-002' });
    expect((screen.getByLabelText('Own setting for A1-002') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getAllByRole('switch')[2].hasAttribute('disabled')).toBe(true);
  });
});
