import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SdReuseSection } from '../../hyyz17200/SdReuseSection';
import { normalizeSdReuse, type SdReuseSettings } from '../../hyyz17200/sdReuseSettings';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

let stored: SdReuseSettings = { enabled: false };
const saved = vi.fn();

beforeEach(() => {
  stored = { enabled: false };
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ sd_reuse: stored })),
    http.put(`${URL}/sd_reuse`, async ({ request }) => {
      stored = (await request.json()) as SdReuseSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('SD card reuse settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('sd-reuse');
  });

  it('is off unless saved on', () => {
    expect(normalizeSdReuse(null)).toEqual({ enabled: false });
    expect(normalizeSdReuse({ enabled: 'yes' })).toEqual({ enabled: false });
    expect(normalizeSdReuse({ enabled: true })).toEqual({ enabled: true });
  });

  it('states the risk on the page', async () => {
    render(<SdReuseSection />);
    expect(await screen.findByText(/power cycle/)).toBeTruthy();
  });

  it('turns on only after the risk is accepted', async () => {
    const user = userEvent.setup();
    render(<SdReuseSection />);

    const toggle = await screen.findByRole('switch');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Accept and turn on' }));
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ enabled: true }));
  });

  it('stays off when the risk is declined', async () => {
    const user = userEvent.setup();
    render(<SdReuseSection />);

    const toggle = await screen.findByRole('switch');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Accept and turn on' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns off without asking', async () => {
    stored = { enabled: true };
    const user = userEvent.setup();
    render(<SdReuseSection />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(screen.queryByRole('button', { name: 'Accept and turn on' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ enabled: false }));
  });
});
