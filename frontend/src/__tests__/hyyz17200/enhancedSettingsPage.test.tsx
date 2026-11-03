import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { EnhancedSettingsPage } from '../../hyyz17200/EnhancedSettingsPage';
import { hyyz17200NavItems } from '../../hyyz17200/nav';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

beforeEach(() => {
  server.use(http.get('/api/v1/hyyz17200/hidden-faults', () => HttpResponse.json([])));
  window.history.replaceState(null, '', '/hyyz17200/settings');
});

afterEach(() => cleanup());

describe('EnhancedSettingsPage', () => {
  it('is the only sidebar entry the fork adds', () => {
    expect(hyyz17200NavItems.map((item) => item.to)).toEqual(['/hyyz17200/settings']);
  });

  it('opens the first tab without a ?tab=', async () => {
    render(<EnhancedSettingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Enhanced Settings' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Hidden Faults' })).toBeTruthy();
    expect(await screen.findByText('No codes are hidden.')).toBeTruthy();
  });

  it('keeps the open tab in the URL', async () => {
    const user = userEvent.setup();
    const last = enhancedSettingsSections[enhancedSettingsSections.length - 1];
    window.history.replaceState(null, '', '/hyyz17200/settings?tab=nope');
    render(<EnhancedSettingsPage />);

    // An unknown tab falls back to the first.
    expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('Hidden Faults');

    await user.click(screen.getAllByRole('button').find((button) => button.closest('nav'))!);
    expect(window.location.search).toBe('');
    if (last.id !== enhancedSettingsSections[0].id) {
      await user.click(screen.getAllByRole('button').filter((button) => button.closest('nav')).pop()!);
      expect(window.location.search).toBe(`?tab=${last.id}`);
    }
  });
});
