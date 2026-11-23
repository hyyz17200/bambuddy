import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CameraLedSection } from '../../hyyz17200/cameraLed/CameraLedSection';
import { CAMERA_LED_DEFAULTS, normalizeCameraLed, type CameraLedSettings } from '../../hyyz17200/cameraLed/cameraLedSettings';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

let stored: CameraLedSettings = { ...CAMERA_LED_DEFAULTS };
const saved = vi.fn();

beforeEach(() => {
  stored = { ...CAMERA_LED_DEFAULTS };
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ camera_led: stored })),
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
    expect(normalizeCameraLed(null)).toEqual({ enabled: false, obico_force: false, off_delay_seconds: 60 });
    expect(normalizeCameraLed({ enabled: 'yes', obico_force: true, off_delay_seconds: 5000 })).toEqual({
      enabled: false,
      obico_force: true,
      off_delay_seconds: 60,
    });
    expect(normalizeCameraLed({ enabled: true, obico_force: false, off_delay_seconds: 0 })).toEqual({
      enabled: true,
      obico_force: false,
      off_delay_seconds: 0,
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

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ enabled: true, obico_force: true, off_delay_seconds: 60 }));
  });

  it('shows what was saved', async () => {
    stored = { enabled: false, obico_force: true, off_delay_seconds: 120 };
    render(<CameraLedSection />);

    await screen.findByText('Always on while Obico checks');
    const [printing, obico] = screen.getAllByRole('switch');
    expect(printing.getAttribute('aria-checked')).toBe('false');
    expect(obico.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Off after (seconds)') as HTMLInputElement).value).toBe('120');
  });
});
