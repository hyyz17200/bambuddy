import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CameraWall, type CameraWallStatus } from '../../components/CameraWall';
import { CamWallSection } from '../../hyyz17200/CamWallSection';
import {
  CAM_WALL_DEFAULTS,
  applyCamWall,
  normalizeCamWall,
  type CamWallSettings,
} from '../../hyyz17200/camWallSettings';

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

afterEach(() => {
  applyCamWall(CAM_WALL_DEFAULTS);
  cleanup();
});

describe('cam wall settings', () => {
  it('falls back to the default field by field', () => {
    expect(normalizeCamWall(null)).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 0, max_live_limit: 257 })).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 17, max_live_limit: 0 })).toEqual(CAM_WALL_DEFAULTS);
    expect(normalizeCamWall({ max_concurrent_captures: 6, max_live_limit: 96 })).toEqual({
      max_concurrent_captures: 6,
      max_live_limit: 96,
    });
  });

  it('saves an edited concurrency', async () => {
    const user = userEvent.setup();
    render(<CamWallSection />);

    const field = await screen.findByLabelText('Captures at once');
    expect((field as HTMLInputElement).value).toBe('2');
    await user.clear(field);
    await user.type(field, '8');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ ...CAM_WALL_DEFAULTS, max_concurrent_captures: 8 }));
  });

  it('saves a live streams limit above 16', async () => {
    const user = userEvent.setup();
    render(<CamWallSection />);

    const field = await screen.findByLabelText('Max live streams limit');
    expect((field as HTMLInputElement).value).toBe('16');
    await user.clear(field);
    await user.type(field, '96');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ ...CAM_WALL_DEFAULTS, max_live_limit: 96 }));
  });

  it('restores the defaults', async () => {
    const user = userEvent.setup();
    stored = { max_concurrent_captures: 6, max_live_limit: 40 };
    render(<CamWallSection />);

    const field = await screen.findByLabelText('Captures at once');
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('6'));
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect((field as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Max live streams limit') as HTMLInputElement).value).toBe('16');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith(CAM_WALL_DEFAULTS));
  });
});

describe('the wall and the live streams limit', () => {
  // jsdom never reports anything on screen: report every tile as visible.
  class EverythingVisible {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', EverythingVisible);
  });

  afterEach(() => vi.unstubAllGlobals());

  const printers = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
  const statuses = new Map<number, CameraWallStatus>(printers.map((p) => [p.id, { connected: true, state: 'IDLE' }]));
  const liveTiles = () =>
    Array.from(document.querySelectorAll('img')).filter((img) => img.getAttribute('src')?.includes('/camera/stream'))
      .length;

  const renderWall = (maxLive: number) =>
    render(
      <CameraWall
        printers={printers}
        maxLive={maxLive}
        snapshotIntervalSec={8}
        statusMode="off"
        statuses={statuses}
        onChangeMaxLive={() => {}}
        onChangeSnapshotIntervalSec={() => {}}
        onChangeStatusMode={() => {}}
      />,
    );

  it('caps live tiles at 16 by default, like upstream', async () => {
    renderWall(25);
    await waitFor(() => expect(liveTiles()).toBe(16));
  });

  it('goes past 16 once the limit is raised', async () => {
    renderWall(25);
    await waitFor(() => expect(liveTiles()).toBe(16));

    act(() => applyCamWall({ ...CAM_WALL_DEFAULTS, max_live_limit: 96 }));

    await waitFor(() => expect(liveTiles()).toBe(25));
  });
});
