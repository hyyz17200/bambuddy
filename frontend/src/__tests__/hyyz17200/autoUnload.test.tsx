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

const URL = '/api/v1/hyyz17200/settings';

let stored: AutoUnloadSettings = AUTO_UNLOAD_DEFAULTS;
const saved = vi.fn();

beforeEach(() => {
  stored = AUTO_UNLOAD_DEFAULTS;
  saved.mockClear();
  server.use(
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
