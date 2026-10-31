import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../utils';
import { CameraTile } from '../../components/CameraTile';
import { setStreamToken } from '../../api/client';
import { formatFrameAge } from '../../hyyz17200/useWallFrame';

const NAME = 'P1S-Garage';
const FRAME_URL = '/hyyz17200/printers/7/camera/snapshot-cached';

type Answer = () => Response | Promise<Response>;

const frame = (etag = '"a"', age = 0) => () =>
  new Response(new Uint8Array([0xff, 0xd8, 1, 2]), {
    status: 200,
    headers: { ETag: etag, 'X-Hyyz17200-Frame-Age': String(age), 'X-Hyyz17200-Capture-Failures': '0' },
  });
const unchanged = (age = 0, failures = 0) => () =>
  new Response(null, {
    status: 304,
    headers: { 'X-Hyyz17200-Frame-Age': String(age), 'X-Hyyz17200-Capture-Failures': String(failures) },
  });
const noFrameYet = (failures = 0) => () =>
  new Response(null, { status: 204, headers: { 'X-Hyyz17200-Capture-Failures': String(failures) } });
const status = (code: number) => () => new Response(null, { status: code });

describe('cam wall frames', () => {
  let answers: Answer[];
  let fetchMock: ReturnType<typeof vi.spyOn>;

  const frameCalls = () =>
    fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes(FRAME_URL));
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const shown = (container: HTMLElement) => container.querySelector('img[src^="blob:"]') as HTMLImageElement | null;
  const snapshotTile = (props: Partial<Parameters<typeof CameraTile>[0]> = {}) => (
    <CameraTile printerId={7} printerName={NAME} mode="snapshot" snapshotIntervalMs={30_000} connected {...props} />
  );

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    answers = [];
    let blobs = 0;
    URL.createObjectURL = vi.fn(() => `blob:frame-${++blobs}`);
    URL.revokeObjectURL = vi.fn();
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      if (!String(input).includes(FRAME_URL)) return new Response(null, { status: 200 });
      return (answers.shift() ?? unchanged())();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setStreamToken(null);
  });

  describe('a snapshot tile', () => {
    it('shows the frame without loading the camera through an img', async () => {
      answers = [frame()];
      const { container } = render(snapshotTile());
      await advance(600);

      expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
      expect(container.querySelector('img[src*="/api/"]')).toBeNull();
      expect(String(frameCalls()[0][0])).toContain('interval=30');
    });

    it.each([
      ['the server refuses', status(503)],
      ['the capture keeps failing', unchanged(90, 3)],
      ['the answer has no frame', noFrameYet(3)],
      ['the request fails', () => Promise.reject(new TypeError('network'))],
    ])('keeps the same picture when %s', async (_name, failure) => {
      answers = [frame(), failure, failure, failure];
      render(snapshotTile());
      await advance(600);
      const img = screen.getByAltText(NAME);

      await advance(40_000);

      expect(frameCalls().length).toBeGreaterThanOrEqual(4);
      expect(screen.getByAltText(NAME)).toBe(img);
      expect(img.getAttribute('src')).toBe('blob:frame-1');
      expect(screen.queryByText('No signal')).toBeNull();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it('replaces the picture in place, and frees the old one', async () => {
      answers = [frame('"a"'), frame('"b"')];
      render(snapshotTile());
      await advance(600);
      const img = screen.getByAltText(NAME);

      await advance(10_000);

      expect(screen.getByAltText(NAME)).toBe(img);
      expect(img.getAttribute('src')).toBe('blob:frame-2');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
    });

    it('does not replace the picture with one that cannot be decoded', async () => {
      const decode = vi.fn(async () => {});
      (HTMLImageElement.prototype as unknown as { decode: unknown }).decode = decode;
      try {
        answers = [frame('"a"'), frame('"b"')];
        render(snapshotTile());
        await advance(600);
        decode.mockRejectedValueOnce(new Error('broken'));

        await advance(10_000);

        expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-2');
      } finally {
        delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
      }
    });

    it('asks once at a time', async () => {
      answers = [() => new Promise<Response>(() => {})];
      render(snapshotTile());
      await advance(9_000);

      expect(frameCalls()).toHaveLength(1);
    });

    it('sends what it already has, and a 304 keeps it', async () => {
      answers = [frame('"a"'), unchanged()];
      render(snapshotTile());
      await advance(10_600);

      const headers = (frameCalls()[1][1] as RequestInit).headers as Record<string, string>;
      expect(headers['If-None-Match']).toBe('"a"');
      expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
    });

    it('asks sooner while it has no frame', async () => {
      answers = [noFrameYet(), noFrameYet(), frame()];
      render(snapshotTile());
      await advance(4_600);

      expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
    });

    it('shows no signal only with no frame and failing captures, and recovers', async () => {
      answers = [noFrameYet(1), noFrameYet(2), noFrameYet(3), frame()];
      render(snapshotTile());
      await advance(600);
      expect(screen.queryByText('No signal')).toBeNull();

      await advance(2_000);
      expect(screen.getByText('No signal')).toBeInTheDocument();

      await advance(4_000);
      expect(screen.queryByText('No signal')).toBeNull();
      expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
    });

    it('marks an old frame with its age, and clears that with a new one', async () => {
      answers = [frame('"a"', 0), unchanged(600), frame('"b"', 1)];
      render(snapshotTile());
      await advance(600);
      expect(screen.queryByText(/ago/)).toBeNull();

      await advance(10_000);
      expect(screen.getByText('10m ago')).toBeInTheDocument();

      await advance(10_000);
      expect(screen.queryByText(/ago/)).toBeNull();
    });

    it('keeps the frame while offline, under the offline mark', async () => {
      answers = [frame()];
      const { rerender, container } = render(snapshotTile());
      await advance(600);
      const calls = frameCalls().length;

      await act(async () => {
        rerender(snapshotTile({ connected: false }));
      });
      await advance(60_000);

      expect(shown(container)?.getAttribute('src')).toBe('blob:frame-1');
      expect(frameCalls()).toHaveLength(calls);
    });

    it('does not ask while the page is hidden, and asks when it comes back', async () => {
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      render(snapshotTile());
      await advance(60_000);
      expect(frameCalls()).toHaveLength(0);

      hidden.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(frameCalls()).toHaveLength(1);
      hidden.mockRestore();
    });

    it('stops asking and frees the frame when it goes away', async () => {
      answers = [frame()];
      const { unmount } = render(snapshotTile());
      await advance(600);
      const calls = frameCalls().length;

      unmount();
      await advance(60_000);

      expect(frameCalls()).toHaveLength(calls);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
    });
  });

  describe('an expired token', () => {
    it('is replaced once for the whole wall', async () => {
      const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries').mockResolvedValue();
      vi.setSystemTime(Date.now() + 3_600_000);
      setStreamToken('old');
      answers = [status(401), status(401)];
      render(
        <>
          {snapshotTile()}
          {snapshotTile()}
        </>,
      );
      await advance(600);

      const calls = invalidate.mock.calls.filter(([f]) =>
        JSON.stringify(f?.queryKey ?? '').includes('camera-stream-token'),
      );
      expect(calls).toHaveLength(1);
    });

    it('is not asked for before there is one', async () => {
      const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries').mockResolvedValue();
      vi.setSystemTime(Date.now() + 7_200_000);
      answers = [status(401)];
      render(snapshotTile());
      await advance(600);

      expect(invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey ?? '').includes('camera-stream-token'))).toEqual([]);
    });
  });

  describe('a live tile', () => {
    const liveTile = () => snapshotTile({ mode: 'live' });
    const streamShowsFrame = () =>
      act(async () => {
        screen.getByAltText(NAME).dispatchEvent(new Event('load'));
      });

    it('asks for no frame until its stream has shown one', async () => {
      // The stream may still be opening the printer's one camera connection.
      render(liveTile());
      await advance(5_000);
      expect(frameCalls()).toHaveLength(0);

      await streamShowsFrame();
      await advance(600);
      expect(frameCalls()).toHaveLength(1);
    });

    it('asks after a while if the stream never shows a frame', async () => {
      render(liveTile());
      await advance(15_000);
      await advance(600);

      expect(frameCalls()).toHaveLength(1);
    });

    it('keeps the stream hidden until it has a frame, over the last good one', async () => {
      answers = [frame()];
      const { container } = render(liveTile());
      expect(screen.getByAltText(NAME).className).toContain('opacity-0');
      await streamShowsFrame();
      expect(screen.getByAltText(NAME).className).not.toContain('opacity-0');
      await advance(600);

      // The renewal closes the stream and opens another: the frame stays under it.
      await advance(60_500);

      expect(shown(container)?.getAttribute('src')).toBe('blob:frame-1');
      expect(screen.getByAltText(NAME).getAttribute('src')).toContain('/camera/stream');
      expect(screen.getByAltText(NAME).className).toContain('opacity-0');
    });

    it('falls back to the last good frame when the stream fails', async () => {
      answers = [frame()];
      render(liveTile());
      await streamShowsFrame();
      await advance(600);

      await act(async () => {
        screen.getByAltText(NAME).dispatchEvent(new Event('error'));
      });

      expect(screen.getByAltText(NAME).getAttribute('src')).toBe('blob:frame-1');
      expect(screen.queryByText('No signal')).toBeNull();
      expect(screen.getByText('Snap')).toBeInTheDocument();
    });

    it('reopens the stream after a minute, once a capture has worked', async () => {
      answers = [frame('"a"')];
      const { container } = render(liveTile());
      await streamShowsFrame();
      await advance(600);
      await act(async () => {
        screen.getByAltText(NAME).dispatchEvent(new Event('error'));
      });

      await advance(30_000);
      expect(container.querySelector('img[src*="/camera/stream"]')).toBeNull();

      answers = [frame('"b"')];
      await advance(35_000);
      expect(container.querySelector('img[src*="/camera/stream"]')).not.toBeNull();
    });

    it('does not reopen the stream while captures fail', async () => {
      answers = [frame('"a"')];
      const { container } = render(liveTile());
      await streamShowsFrame();
      await advance(600);
      await act(async () => {
        screen.getByAltText(NAME).dispatchEvent(new Event('error'));
      });

      await advance(180_000);

      expect(container.querySelector('img[src*="/camera/stream"]')).toBeNull();
    });
  });

  it('formats a frame age', () => {
    expect(formatFrameAge(42)).toBe('42s');
    expect(formatFrameAge(600)).toBe('10m');
    expect(formatFrameAge(3_900)).toBe('1h 5m');
  });
});
