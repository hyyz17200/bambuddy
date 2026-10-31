import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStreamToken, withStreamToken } from '../api/client';

/** A poll is answered from the server's cache, so it never waits for the printer:
 *  asking more often than the capture interval only shows a new frame sooner. */
const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const REPOLL_AFTER_401_MS = 5_000;
const TOKEN_REFRESH_GAP_MS = 5_000;
const START_SPREAD_MS = 500;
/** Failed captures in a row before a tile with no frame says it has no signal. */
const NO_SIGNAL_AFTER = 2;

export interface WallFrame {
  /** Blob URL of the last good frame. Kept through failures and while not polling. */
  url: string | null;
  /** Local time the frame was captured. */
  capturedAt: number | null;
  /** New frames received so far. */
  received: number;
  /** No frame, and capturing keeps failing. */
  noSignal: boolean;
}

const NO_FRAME: WallFrame = { url: null, capturedAt: null, received: 0, noSignal: false };

let lastTokenRefresh = -Infinity;

/** Whether the bytes are a picture: a broken one must not replace a good frame. */
async function decodes(url: string): Promise<boolean> {
  const probe = new Image();
  probe.src = url;
  if (typeof probe.decode !== 'function') return true;
  try {
    await probe.decode();
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls a printer's cached camera frame while `enabled`, one request at a time.
 *
 * Uses fetch rather than an `<img>`: a failure replaces nothing on screen, the
 * status tells an expired token from a busy camera, and it does not reach the
 * app's listener that re-mints the stream token on any failed camera image and so
 * reconnects every camera on the page.
 */
export function useWallFrame(printerId: number, intervalMs: number, enabled: boolean): WallFrame {
  const queryClient = useQueryClient();
  const [frame, setFrame] = useState<WallFrame>(NO_FRAME);
  const etagRef = useRef<string | null>(null);
  const frameUrl = frame.url;

  useEffect(() => {
    etagRef.current = null;
    setFrame(NO_FRAME);
  }, [printerId]);

  // Revoked after the commit that replaced it, once no img shows it.
  useEffect(() => {
    if (!frameUrl) return;
    return () => URL.revokeObjectURL(frameUrl);
  }, [frameUrl]);

  useEffect(() => {
    if (!enabled) return;

    const intervalSec = Math.round(intervalMs / 1000);
    const pollMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, intervalMs / 3));
    const url = `/api/v1/hyyz17200/printers/${printerId}/camera/snapshot-cached?interval=${intervalSec}`;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;

    const pollAfter = (ms: number) => {
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, ms);
    };

    const receive = async (response: Response) => {
      const failures = Number(response.headers.get('X-Hyyz17200-Capture-Failures') ?? 0);
      const age = Number(response.headers.get('X-Hyyz17200-Frame-Age') ?? 0);
      const capturedAt = Date.now() - age * 1000;

      if (response.status === 204) {
        setFrame((prev) => ({ ...prev, noSignal: failures >= NO_SIGNAL_AFTER }));
        return;
      }
      if (response.status === 304) {
        setFrame((prev) => ({ ...prev, capturedAt }));
        return;
      }
      if (!response.ok) return;

      const blob = await response.blob();
      if (blob.size === 0) return;
      const nextUrl = URL.createObjectURL(blob);
      if (stopped || !(await decodes(nextUrl)) || stopped) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      etagRef.current = response.headers.get('ETag');
      setFrame((prev) => ({ url: nextUrl, capturedAt, received: prev.received + 1, noSignal: false }));
    };

    const poll = async () => {
      // The stream token is not refreshed in a hidden page. Picked up again by
      // the listener below.
      if (document.hidden) return;

      const controller = new AbortController();
      inFlight = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let nextPoll = pollMs;
      try {
        const headers: Record<string, string> = etagRef.current ? { 'If-None-Match': etagRef.current } : {};
        const response = await fetch(withStreamToken(url), { cache: 'no-store', headers, signal: controller.signal });
        if (response.status === 401) {
          nextPoll = REPOLL_AFTER_401_MS;
          // With no token yet there is nothing to replace: one is on its way.
          // Shared by every tile, or a wall would mint one token per tile.
          if (getStreamToken() && Date.now() - lastTokenRefresh >= TOKEN_REFRESH_GAP_MS) {
            lastTokenRefresh = Date.now();
            void queryClient.invalidateQueries({ queryKey: ['camera-stream-token'] });
          }
        } else {
          await receive(response);
          if (response.status === 204) nextPoll = MIN_POLL_MS;
        }
      } catch {
        // The server is unreachable or too slow: keep the frame and ask again.
      } finally {
        clearTimeout(timeout);
        if (inFlight === controller) inFlight = null;
      }
      if (!stopped) pollAfter(nextPoll);
    };

    const onVisibilityChange = () => {
      if (!document.hidden && timer === null && inFlight === null) void poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Spread out, so a wall's tiles do not all ask at the same moment.
    pollAfter(Math.random() * START_SPREAD_MS);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [printerId, intervalMs, enabled, queryClient]);

  return frame;
}

/** How old a frame is, for the tile's stale badge. */
export function formatFrameAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
