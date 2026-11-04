"""The last good camera frame of each printer, for the cam wall.

A cam wall tile that asks /camera/snapshot holds a browser connection for as long
as the capture takes (up to 15s), and a failed capture leaves it with nothing. Here
a request is answered at once with the last good frame, and a capture runs in the
background when one is due. So a slow or failed capture only makes the frame older.

Captures run while somebody asks, at most one per printer, a few at a time (the
Enhanced Settings' cam wall section sets how many), and less often while a printer
keeps failing. They go through the upstream snapshot route,
which reuses a running live view's frame instead of opening a second connection.

Only the wall uses this. Finish photos and plate detection need a frame taken now,
and keep capturing directly.
"""

import asyncio
import hashlib
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.app.api.routes.camera import camera_snapshot

logger = logging.getLogger(__name__)

# The default of CamWallSettings.max_concurrent_captures. Each capture opens its
# own printer's camera, so more at once costs this server, not the printers.
DEFAULT_CONCURRENT_CAPTURES = 2
# Each of a capture's steps has its own 15s timeout, so it needs an overall limit
# to give its slot back.
CAPTURE_DEADLINE_SECONDS = 30.0
MAX_BACKOFF_SECONDS = 120.0
FORGET_AFTER_SECONDS = 3600.0

JPEG_START = b"\xff\xd8"


@dataclass
class _Entry:
    frame: bytes | None = None
    etag: str | None = None
    captured_at: float = 0.0
    last_attempt: float | None = None
    last_read: float = 0.0
    failures: int = 0
    task: asyncio.Task | None = None


@dataclass(frozen=True)
class FrameRead:
    frame: bytes | None
    etag: str | None
    age_seconds: int
    failures: int


class CamWallSettings(BaseModel):
    """The Enhanced Settings' cam wall section."""

    max_concurrent_captures: int = Field(default=DEFAULT_CONCURRENT_CAPTURES, ge=1, le=16)


class _CaptureSlots:
    """A semaphore whose size can change while captures wait on it. First come,
    first served, so every printer on the wall gets its turn."""

    def __init__(self, limit: int):
        self.limit = limit
        self.active = 0
        self._waiters: deque[asyncio.Future] = deque()

    def set_limit(self, limit: int) -> None:
        self.limit = limit
        self._wake()

    def _wake(self) -> None:
        while self._waiters and self.active < self.limit:
            waiter = self._waiters.popleft()
            if not waiter.done():
                self.active += 1
                waiter.set_result(None)

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        if self.active < self.limit and not self._waiters:
            self.active += 1
        else:
            waiter = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            try:
                await waiter
            except asyncio.CancelledError:
                if waiter.done() and not waiter.cancelled():
                    # Given a slot just as it was cancelled: pass it on.
                    self.active -= 1
                    self._wake()
                else:
                    try:
                        self._waiters.remove(waiter)
                    except ValueError:
                        pass
                raise
        try:
            yield
        finally:
            self.active -= 1
            self._wake()


_entries: dict[int, _Entry] = {}
_capture_slots = _CaptureSlots(DEFAULT_CONCURRENT_CAPTURES)


def apply_settings(value: CamWallSettings) -> None:
    """Use a saved cam wall section. A change applies to the captures waiting now."""
    _capture_slots.set_limit(value.max_concurrent_captures)


def _now() -> float:
    return time.monotonic()


def read_frame(printer_id: int, interval: int) -> FrameRead:
    """The printer's last good frame, starting a capture if one is due."""
    now = _now()
    _forget_unread(now)
    entry = _entries.setdefault(printer_id, _Entry())
    entry.last_read = now
    if _capture_due(entry, interval, now):
        entry.task = asyncio.create_task(_capture(entry, printer_id), name=f"hyyz17200-frame-{printer_id}")
    return FrameRead(
        frame=entry.frame,
        etag=entry.etag,
        age_seconds=int(now - entry.captured_at) if entry.frame else 0,
        failures=entry.failures,
    )


def forget(printer_id: int) -> None:
    """Drop a printer's frame: the printer is gone."""
    entry = _entries.pop(printer_id, None)
    if entry is not None and entry.task is not None:
        entry.task.cancel()


def _capture_due(entry: _Entry, interval: int, now: float) -> bool:
    if entry.task is not None:
        return False
    if entry.last_attempt is None:
        return True
    # Doubles per failure in a row: the first failure waits the usual interval.
    wait = interval
    if entry.failures > 1:
        wait = min(interval * 2.0 ** (entry.failures - 1), max(interval, MAX_BACKOFF_SECONDS))
    return now - entry.last_attempt >= wait


def _forget_unread(now: float) -> None:
    for printer_id, entry in list(_entries.items()):
        if entry.task is None and now - entry.last_read >= FORGET_AFTER_SECONDS:
            del _entries[printer_id]


async def _capture(entry: _Entry, printer_id: int) -> None:
    frame = None
    try:
        async with _capture_slots.slot():
            # Called directly, so its route dependency does not run: the request
            # that started this capture has passed the same check.
            response = await asyncio.wait_for(camera_snapshot(printer_id, None), CAPTURE_DEADLINE_SECONDS)
        body = bytes(response.body)
        if body.startswith(JPEG_START):
            frame = body
        else:
            logger.warning("Cam wall capture for printer %s did not return a JPEG", printer_id)
    except HTTPException as exc:
        # Routine: the camera is busy or a live view is still starting.
        logger.debug("Cam wall capture for printer %s failed: %s", printer_id, exc.detail)
    except TimeoutError:
        logger.warning("Cam wall capture for printer %s ran out of time", printer_id)
    except Exception:
        logger.exception("Cam wall capture for printer %s failed", printer_id)
    finally:
        entry.task = None
        entry.last_attempt = _now()

    if frame is None:
        entry.failures += 1
        return
    entry.failures = 0
    entry.frame = frame
    entry.etag = f'"{hashlib.sha256(frame).hexdigest()[:32]}"'
    entry.captured_at = _now()
