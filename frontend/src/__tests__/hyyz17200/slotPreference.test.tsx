import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SlotPreferenceSection } from '../../hyyz17200/SlotPreferenceSection';
import { normalizeSlotPreference, type SlotPreferenceSettings } from '../../hyyz17200/slotPreferenceSettings';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

let stored: SlotPreferenceSettings = { enabled: false };
const saved = vi.fn();

beforeEach(() => {
  stored = { enabled: false };
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ slot_preference: stored })),
    http.put(`${URL}/slot_preference`, async ({ request }) => {
      stored = (await request.json()) as SlotPreferenceSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('slot preference settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('slot-preference');
  });

  it('is off unless saved on', () => {
    expect(normalizeSlotPreference(null)).toEqual({ enabled: false });
    expect(normalizeSlotPreference({ enabled: 'yes' })).toEqual({ enabled: false });
    expect(normalizeSlotPreference({ enabled: true })).toEqual({ enabled: true });
  });

  it('starts off and saves it turned on', async () => {
    const user = userEvent.setup();
    render(<SlotPreferenceSection />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ enabled: true }));
  });

  it('shows what was saved', async () => {
    stored = { enabled: true };
    render(<SlotPreferenceSection />);

    expect((await screen.findByRole('switch')).getAttribute('aria-checked')).toBe('true');
  });
});
