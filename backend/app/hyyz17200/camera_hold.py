"""Keep a printer's camera connected, as if someone were watching it live.

Some A1s (seen 2026-11-24 on A1-038, 039, 052, 055, 056; firmware
01.07.00.00, the same as A1s that behave) switch their LED off every time a
camera connection closes, while still reporting it on. The Obico check
connects every interval for about 3 seconds, so the light shows 2 seconds on
and 7 off. Switching the light off and on again (MQTT or the screen), or a
power cycle, does not stop it; an open live view does. So this holds one.

A hold is an extra subscriber of upstream's fan-out broadcaster for the
printer (the one ``/camera/stream`` uses, key ``printer-<id>``, same upstream
generator), which only drops the frames. While it runs:

- upstream sees a live stream (``is_stream_active``), so the Obico check, the
  camera wall and every snapshot take the buffered frame instead of opening a
  connection of their own;
- a viewer who opens the live view joins the same upstream, and leaving does
  not close it (``/camera/stop`` skips the teardown while a subscriber is left).

Only for the built-in chamber-image camera (A1/P1): the fault is theirs, and an
RTSP camera or an external camera has its own upstream. The camera LED module
decides which printers are held and when (while it holds their light).

When the upstream ends (printer offline, a camera error), the hold reconnects
after ``RETRY_SECONDS``, doubling while no frame arrives, up to
``MAX_RETRY_SECONDS``. Stopping a hold unsubscribes; the broadcaster closes the
connection after its own 5-second grace if nobody else is watching.
"""

from __future__ import annotations

import asyncio
import logging
import time

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task

logger = logging.getLogger(__name__)

RETRY_SECONDS = 5.0
MAX_RETRY_SECONDS = 120.0
# The rate a viewer joining the held upstream gets: the chamber-image maximum,
# as /camera/stream allows for A1/P1.
FPS = 5

_sleep = asyncio.sleep  # the retry wait; tests replace it

_holds: dict[int, asyncio.Task] = {}
# printer_id -> what the hold is doing, for logs and tests.
_state: dict[int, str] = {}


def held_printer_ids() -> set[int]:
    return {pid for pid, task in _holds.items() if not task.done()}


def state(printer_id: int) -> str | None:
    return _state.get(printer_id)


def hold(printer_ids: set[int]) -> None:
    """Hold exactly these printers' cameras: start the missing, stop the rest."""
    for printer_id in list(_holds):
        if printer_id not in printer_ids:
            release(printer_id)
    for printer_id in printer_ids:
        # A finished task stays listed (a printer that cannot be held), so it
        # is not tried again every pass; release() clears it.
        if printer_id not in _holds:
            _holds[printer_id] = spawn_background_task(_run(printer_id), name=f"hyyz17200-camera-hold-{printer_id}")


def release(printer_id: int) -> None:
    task = _holds.pop(printer_id, None)
    _state.pop(printer_id, None)
    if task is not None and not task.done():
        task.cancel()
        logger.info("hyyz17200 camera hold: printer %s camera let go", printer_id)


def release_all() -> None:
    for printer_id in list(_holds):
        release(printer_id)


def install() -> None:
    """Tell the AI check's frame path that a held camera is taken, also while
    the hold waits to reconnect: it must wait for the hold's next frame instead
    of opening a connection of its own."""
    from backend.app.services import failure_detection_camera

    failure_detection_camera.register_camera_claim(is_held)


def is_held(printer_id: int) -> bool:
    task = _holds.get(printer_id)
    return task is not None and not task.done()


async def _load(printer_id: int):
    from backend.app.models.printer import Printer

    async with database.async_session() as db:
        return await db.get(Printer, printer_id)


def _holdable(printer) -> str | None:
    """Why this printer's camera is not held, or None."""
    from backend.app.services.camera import is_chamber_image_model

    if printer is None:
        return "printer not found"
    if printer.external_camera_enabled and printer.external_camera_url:
        return "external camera"
    if not is_chamber_image_model(printer.model):
        return f"not a chamber-image camera ({printer.model})"
    return None


def _is_frame(chunk: bytes) -> bool:
    # The upstream yields one text part when it cannot connect.
    return b"Content-Type: image/jpeg" in chunk[:64]


async def _watch_once(printer) -> bool:
    """Subscribe to the printer's live upstream until it ends. True if a frame came."""
    from backend.app.api.routes import camera as camera_routes
    from backend.app.services.camera_fanout import get_or_create_broadcaster, iter_subscriber

    printer_id = printer.id
    ip_address, access_code, model = printer.ip_address, printer.access_code, printer.model

    # The same upstream /camera/stream builds for a chamber-image printer.
    def factory(disconnect_event: asyncio.Event):
        return camera_routes.generate_chamber_mjpeg_stream(
            ip_address=ip_address,
            access_code=access_code,
            model=model,
            fps=FPS,
            stream_id=camera_routes._new_fanout_stream_id(printer_id),
            disconnect_event=disconnect_event,
            printer_id=printer_id,
        )

    key = f"printer-{printer_id}"
    broadcaster = await get_or_create_broadcaster(key, factory)
    try:
        queue = await broadcaster.subscribe()
    except RuntimeError:
        # Stopped between the lookup and the subscribe (grace teardown).
        broadcaster = await get_or_create_broadcaster(key, factory)
        queue = await broadcaster.subscribe()
    camera_routes._stream_start_times.setdefault(printer_id, time.time())

    got_frame = False
    async for chunk in iter_subscriber(broadcaster, queue):
        if not got_frame and _is_frame(chunk):
            got_frame = True
            _state[printer_id] = "streaming"
            logger.info("hyyz17200 camera hold: printer %s camera held open", printer_id)
    return got_frame


async def _run(printer_id: int) -> None:
    retry = RETRY_SECONDS
    while True:
        got_frame = False
        try:
            printer = await _load(printer_id)
            why = _holdable(printer)
            if why is not None:
                _state[printer_id] = f"skipped: {why}"
                logger.info("hyyz17200 camera hold: printer %s not held: %s", printer_id, why)
                return
            _state[printer_id] = "connecting"
            got_frame = await _watch_once(printer)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("hyyz17200 camera hold: printer %s failed", printer_id)
        retry = RETRY_SECONDS if got_frame else min(retry * 2, MAX_RETRY_SECONDS)
        _state[printer_id] = "retrying"
        logger.info(
            "hyyz17200 camera hold: printer %s camera connection ended, reconnecting in %.0fs", printer_id, retry
        )
        await _sleep(retry)
