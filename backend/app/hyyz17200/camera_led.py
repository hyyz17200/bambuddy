"""Auto camera LED: the chamber light is on for a whole print and off once idle.

Upstream's camera light (services/camera_light.py, #1655) switches the light on
for each camera use and back off 15 seconds after the last one. A printer whose
snapshots come less often than that (the camera wall's frame cache on a big
farm, Home Assistant) gets a flash for every picture, and an A1's camera takes
several seconds to adjust its exposure after each one. This holds the light for
the print instead:

- ``enabled``: every printer, from the moment it takes a job (PREPARE) through
  RUNNING and PAUSE. Switching the light from Bambuddy during the print hands
  it to the user for the rest of that print.
- ``obico_force``: the printers the Obico check monitors, the same stretch, and
  a manual switch does not stop it: a dark frame is useless to the detector.
  Works with or without ``enabled``.

When the print is over (anything but PREPARE/RUNNING/PAUSE/SLICING) the light
goes off after ``off_delay_seconds``, so a queue sending the next job straight
away does not blink it. A switch from Bambuddy after the end leaves it as the
user set it. A camera still in use at that moment (a live view, a finish photo)
gets the light handed to upstream's camera light, which switches it off after
its own grace once the camera is let go.

While the light is held here upstream's camera light never turns it off: it
only turns off a light it switched on itself, and any it has (``_lit_at``) is
taken from it every pass.

Many A1s come up after a power cycle reporting the light on while it is dark,
so the reported state is not trusted when it already matches what is wanted.
Every switch reads it first (:func:`_switch`): reported the other way, one
command is sent; reported the same, the opposite command goes first, then after
a short gap the wanted one. A light held here is not switched again while it
stays held, e.g. between back-to-back queue jobs, unless the printer was
disconnected meanwhile (it may have restarted).

Bambu Handy or the printer's screen switching the light off during a print is
not seen as a user's choice: the light is switched on again within
``RESEND_SECONDS``. Only switches through Bambuddy (upstream's
``camera_light.hand_back``) are.

A printer can also have its camera kept connected while it prints with its
light held here (camera_hold.py): some A1s switch the LED off every time a
camera connection closes, so the Obico check's short connections make it flash,
whatever the light is switched to. ``keep_camera_all`` sets it for every
printer; ``keep_camera_printer_ids`` and ``keep_camera_off_ids`` set it on or
off for one printer whatever the global switch says. The connection is let go as
soon as the printer stops printing (not at the end of the off delay): the queue
uploads the next file in that idle time, and on an A1 the stream and the upload
compete (seen 2026-11-24: 19.9 MB in 95 s without, 155 s with).

All state is in memory; after a restart a print in progress is taken over
(by the same rule) on the first pass.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel, Field, model_validator

from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200 import camera_hold
from backend.app.services import camera_light
from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)

POLL_SECONDS = 5
# Between the opposite command and the wanted one (_switch).
RESYNC_GAP_SECONDS = 2.0
# A light still reported off this long after our "on" gets another one.
RESEND_SECONDS = 15.0
OBICO_SETTINGS_TTL = 30.0

ACTIVE_STATES = frozenset({"PREPARE", "RUNNING", "PAUSE", "SLICING"})


class CameraLedSettings(BaseModel):
    """The Enhanced Settings' auto camera LED section."""

    enabled: bool = False
    obico_force: bool = False
    off_delay_seconds: int = Field(default=60, ge=0, le=1800)
    # Keep the camera connected while printing with the light held here
    # (camera_hold.py): some A1s switch the LED off whenever a camera
    # connection closes. For every printer by default:
    keep_camera_all: bool = False
    # Per printer, whatever keep_camera_all says: on, and off.
    keep_camera_printer_ids: list[int] = Field(default_factory=list, max_length=1000)
    keep_camera_off_ids: list[int] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def _one_choice_per_printer(self) -> CameraLedSettings:
        on = sorted(set(self.keep_camera_printer_ids))
        self.keep_camera_printer_ids = on
        self.keep_camera_off_ids = sorted(set(self.keep_camera_off_ids) - set(on))
        return self

    def keeps_camera(self, printer_id: int) -> bool:
        if printer_id in self.keep_camera_printer_ids:
            return True
        if printer_id in self.keep_camera_off_ids:
            return False
        return self.keep_camera_all


@dataclass
class _Track:
    started: float  # this print stretch began (or was taken over)
    reason: str  # "print" or "obico"
    sent_on_at: float | None = None
    ended_at: float | None = None  # the stretch ended; off after the delay
    lost: bool = False  # disconnected since: the printer may have restarted
    held_back_logged: bool = False


_settings = CameraLedSettings()
_tracks: dict[int, _Track] = {}
# printer_id -> when the light was last switched through Bambuddy.
_manual_at: dict[int, float] = {}
_pending: dict[int, asyncio.Task] = {}
_obico_cache: tuple[float, dict | None] | None = None


def _now() -> float:
    return time.monotonic()


def apply_settings(value: BaseModel) -> None:
    global _settings, _obico_cache
    _settings = CameraLedSettings.model_validate(value.model_dump())
    _obico_cache = None
    if not (_settings.enabled or _settings.obico_force):
        # Lights are left as they are; nothing is held any more.
        for task in _pending.values():
            task.cancel()
        _pending.clear()
        _tracks.clear()
        camera_hold.release_all()


def install() -> None:
    """Notice the user switching the light through Bambuddy. Idempotent."""
    if getattr(camera_light.hand_back, "hyyz17200", False):
        return
    original = camera_light.hand_back

    def hand_back(printer_id: int) -> None:
        _manual_at[printer_id] = _now()
        original(printer_id)

    hand_back.hyyz17200 = True  # type: ignore[attr-defined]
    hand_back.original = original  # type: ignore[attr-defined]
    camera_light.hand_back = hand_back


def _upstream_hand_back(printer_id: int) -> None:
    fn = camera_light.hand_back
    getattr(fn, "original", fn)(printer_id)


def _take_from_camera_light(printer_id: int) -> None:
    """Keep upstream's camera light from switching off a light we hold."""
    if printer_id in camera_light._lit_at or printer_id in camera_light._off_tasks:
        _upstream_hand_back(printer_id)


async def _obico_monitored() -> Callable[[int], bool]:
    global _obico_cache
    from backend.app.services.obico_detection import obico_detection_service

    now = _now()
    if _obico_cache is None or now - _obico_cache[0] >= OBICO_SETTINGS_TTL:
        try:
            settings = await obico_detection_service._load_settings()
        except Exception as e:
            logger.debug("hyyz17200 camera led: could not read the Obico settings: %s", e)
            settings = None
        _obico_cache = (now, settings)
    settings = _obico_cache[1]
    if not settings or not settings.get("enabled") or not settings.get("ml_url"):
        return _nobody
    ids = settings.get("enabled_printers")
    return lambda pid: ids is None or pid in ids


def _nobody(_printer_id: int) -> bool:
    return False


def _reason(printer_id: int, state: object, monitored: Callable[[int], bool]) -> str | None:
    if (getattr(state, "state", None) or "").upper() not in ACTIVE_STATES:
        return None
    if _settings.obico_force and monitored(printer_id):
        return "obico"
    if _settings.enabled:
        return "print"
    return None


def _send(client: object, printer_id: int, on: bool) -> bool:
    try:
        return bool(client.set_chamber_light(on))  # type: ignore[attr-defined]
    except Exception as e:
        logger.warning("hyyz17200 camera led: printer %s: switching the light failed: %s", printer_id, e)
        return False


def _switch(
    printer_id: int, client: object, state: object, on: bool, still_wanted: Callable[[], bool], what: str
) -> bool:
    """Switch the light, not trusting a reported state that already matches.

    Reported the other way: one command. Reported the same (an A1 after a
    power cycle can report on while dark): the opposite command, a short gap,
    then the wanted one, if ``still_wanted()`` by then. Returns whether the
    wanted command was sent or is on its way."""
    old = _pending.pop(printer_id, None)
    if old is not None:
        old.cancel()
    word = "on" if on else "off"
    if bool(getattr(state, "chamber_light", False)) != on:
        if not _send(client, printer_id, on):
            return False
        logger.info("hyyz17200 camera led: printer %s light %s (%s)", printer_id, word, what)
        return True

    async def run() -> None:
        try:
            if not _send(client, printer_id, not on):
                return
            await asyncio.sleep(RESYNC_GAP_SECONDS)
            if not still_wanted():
                return
            if on:
                _take_from_camera_light(printer_id)
            if _send(client, printer_id, on):
                logger.info(
                    "hyyz17200 camera led: printer %s light %s (reported %s already, sent %s first; %s)",
                    printer_id,
                    word,
                    word,
                    "off" if on else "on",
                    what,
                )
        finally:
            if _pending.get(printer_id) is task:
                _pending.pop(printer_id, None)

    task = spawn_background_task(run(), name=f"hyyz17200-camera-led-{printer_id}")
    _pending[printer_id] = task
    return True


def _start(printer_id: int, client: object, state: object, track: _Track, now: float) -> None:
    """Take the light over for a print."""
    _take_from_camera_light(printer_id)

    def still_wanted() -> bool:
        return _tracks.get(printer_id) is track and track.ended_at is None

    if _switch(printer_id, client, state, True, still_wanted, track.reason):
        track.sent_on_at = now


def _step(printer_id: int, state: object, monitored: Callable[[int], bool], now: float) -> None:
    client = printer_manager.get_client(printer_id)
    track = _tracks.get(printer_id)
    if client is None or state is None or not getattr(state, "connected", False):
        if track is not None:
            track.lost = True
        return

    reason = _reason(printer_id, state, monitored)
    if reason is not None:
        if track is None:
            track = _Track(started=now, reason=reason)
            _tracks[printer_id] = track
            _start(printer_id, client, state, track, now)
            return
        if track.ended_at is not None:
            # A new print while the light is still held from the last one.
            track.started, track.ended_at, track.held_back_logged = now, None, False
            track.reason = reason
            if track.lost:
                track.lost = False
                _start(printer_id, client, state, track, now)
            return
        track.reason = reason
        if track.lost:
            track.lost = False
            _start(printer_id, client, state, track, now)
            return
        _take_from_camera_light(printer_id)
        if getattr(state, "chamber_light", False) or printer_id in _pending:
            return
        if track.sent_on_at is not None and now - track.sent_on_at < RESEND_SECONDS:
            return
        if reason != "obico" and _manual_at.get(printer_id, float("-inf")) > track.started:
            if not track.held_back_logged:
                track.held_back_logged = True
                logger.info("hyyz17200 camera led: printer %s light switched off by the user, left off", printer_id)
            return
        # Reported off, so this is a single "on".
        if _switch(printer_id, client, state, True, lambda: True, f"was off during the print, {reason}"):
            track.sent_on_at = now
        return

    if track is None:
        return
    if track.ended_at is None:
        track.ended_at = now
    if now - track.ended_at < _settings.off_delay_seconds:
        return
    _tracks.pop(printer_id, None)
    task = _pending.pop(printer_id, None)
    if task is not None:
        task.cancel()
    if _manual_at.get(printer_id, float("-inf")) > track.ended_at:
        logger.info(
            "hyyz17200 camera led: printer %s light switched by the user after the print, left as is", printer_id
        )
        return
    if camera_light._holders.get(printer_id):
        # A camera is still in use: upstream switches it off once let go.
        camera_light._lit_at[printer_id] = _now()
        logger.info("hyyz17200 camera led: printer %s print over, light off once the camera is let go", printer_id)
        return
    _switch(printer_id, client, state, False, lambda: printer_id not in _tracks, "print over")


async def tick() -> None:
    if not (_settings.enabled or _settings.obico_force):
        return
    monitored = await _obico_monitored() if _settings.obico_force else _nobody
    now = _now()
    statuses = printer_manager.get_all_statuses()
    for printer_id, state in list(statuses.items()):
        try:
            _step(printer_id, state, monitored, now)
        except Exception:
            logger.exception("hyyz17200 camera led: printer %s failed", printer_id)
    for printer_id in [pid for pid in _tracks if pid not in statuses]:
        _tracks.pop(printer_id, None)
    # Held while printing with the light held here, and connected; let go when
    # the print ends (not after the off delay), before the next upload.
    camera_hold.hold(
        {
            pid
            for pid, track in _tracks.items()
            if track.ended_at is None and getattr(statuses.get(pid), "connected", False) and _settings.keeps_camera(pid)
        }
    )


class _Runner:
    """The background loop, run inside the app's lifespan (__init__.py)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-camera-led")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
        for task in _pending.values():
            task.cancel()
        _pending.clear()
        camera_hold.release_all()

    async def _run(self) -> None:
        while True:
            try:
                await tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("hyyz17200 camera led: pass failed")
            await asyncio.sleep(POLL_SECONDS)


runner = _Runner()
