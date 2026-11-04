import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CamWallSection } from '../../hyyz17200/CamWallSection';
import { CAM_WALL_DEFAULTS, normalizeCamWall, type CamWallSettings } from '../../hyyz17200/camWallSettings';

const URL = '/api/v1/hyyz17200/settings';

let stored: CamWallSettings = CAM_WALL_DEFAULTS;
const saved = vi.fn();

beforeEach(() => {
  stored = CAM_WALL_DEFAULTS;
  saved.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json({ cam_wall: stored })),
    http.put(`${URL}/cam_wall`, async ({ request }) => {
      stored = (await request.json()) as CamWallSettings;
      saved(stored);
      return HttpResponse.json(stored);
    }),
  );
});

afterEach(() => cleanup());

describe('cam wall settings', () => {
  it('falls back to the default', () => {
    expect(normalizeCamWall(null)).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 0 })).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 17 })).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 6 })).toEqual({ max_concurrent_captures: 6 });
  });

  it('saves an edited concurrency', async () => {
    const user = userEvent.setup();
    render(<CamWallSection />);

    const field = await screen.findByLabelText('Captures at once');
    expect((field as HTMLInputElement).value).toBe('2');
    await user.clear(field);
    await user.type(field, '8');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ max_concurrent_captures: 8 }));
  });

  it('restores the default', async () => {
    const user = userEvent.setup();
    stored = { max_concurrent_captures: 6 };
    render(<CamWallSection />);

    const field = await screen.findByLabelText('Captures at once');
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('6'));
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect((field as HTMLInputElement).value).toBe('2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith(CAM_WALL_DEFAULTS));
  });
});
