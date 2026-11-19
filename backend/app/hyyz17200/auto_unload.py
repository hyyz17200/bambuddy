"""Unload a printer's filament back into its AMS once it has sat idle a while.

The farm's end G-code leaves the filament in the toolhead, so back-to-back jobs
skip an unload and a reload. When the queue runs dry, this returns it to the
AMS, so the spools can be taken out without unloading each printer by hand.

A printer is unloaded once per idle stretch, when all of these hold:

- connected and IDLE or FINISH (not FAILED: a failed print may be a feeding
  problem) for ``idle_minutes``, with its state, loaded slot and AMS status
  unchanged all that time;
- a single-nozzle printer without an AMS 3H, fed from an AMS slot that holds a
  spool. The external spool would need pulling out by hand, so it is left;
- its AMS idle and not drying, no fault showing (hidden codes do not count),
  no queue job on its way, the scheduler not keeping its bed warm for a job,
  and not in a calibration batch.

Before the command a full report is asked for (pushall, as the card's Force
Refresh) and every check runs again on it: the partial reports A1 and P1 send
in between can lag behind a change made on the printer's screen. The slot must
still be the one first seen. The command is upstream's ``ams_unload_filament``,
the one the card's unload button sends, addressed to that slot. With a cold
nozzle it asks for 210 °C, which is what Bambu Studio's unload button sends for
every material.

From the refresh until the unload ends, the queue treats the printer as busy
(printer_intake.queue_skipped_printer_ids) and so does the calibration batch.
The unload is done when the printer reports nothing loaded and its AMS idle,
and is given up on after ``UNLOAD_TIMEOUT_SECONDS``. Either way it is logged
and not tried again until the printer has printed. A failed unload shows as the
printer's own HMS fault.

The cost is a pass over the printers' in-memory state every ``POLL_SECONDS``.
The database and the printer are only asked once a printer's idle time is up.
Tracking is in memory, so after a restart the idle time counts from then.
"""

import asyncio
import json
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200 import hms_filter
from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)

POLL_SECONDS = 30
# How long to wait for the full report a pushall asks for.
REFRESH_TIMEOUT_SECONDS = 10.0
# A pushall answer has every field; the partial reports in between have a few.
# Upstream tells them apart the same way.
FULL_REPORT_KEYS = 30
# The report is handled on paho's thread right after the raw handlers see it.
REPORT_SETTLE_SECONDS = 0.5
# Refreshes that went unanswered before the idle stretch is given up on.
REFRESH_TRIES = 3
FOLLOW_SECONDS = 2.0
UNLOAD_TIMEOUT_SECONDS = 300
# Without the AMS ever reporting the unload, the state just after the command
# may simply be the old one: "nothing loaded" counts only after this long.
UNSEEN_UNLOAD_SECONDS = 20

IDLE_STATES = frozenset({"IDLE", "FINISH"})
ACTIVE_STATES = frozenset({"PREPARE", "RUNNING", "PAUSE", "SLICING"})
NOTHING_LOADED = 255
EXTERNAL_SPOOL = 254


class AutoUnloadSettings(BaseModel):
    """The Enhanced Settings' auto unload section."""

    enabled: bool = False
    idle_minutes: int = Field(default=30, ge=5, le=720)


@dataclass
class _Track:
    client: object
    key: tuple
    since: float
    # This idle stretch has had its unload. Cleared when the printer prints.
    tried: bool = False
    refresh_failures: int = 0


_settings = AutoUnloadSettings()
_tracks: dict[int, _Track] = {}
# printer_id -> when the attempt began. The queue keeps jobs off these.
_busy: dict[int, float] = {}
_attempts: dict[int, asyncio.Task] = {}


def apply_settings(value: BaseModel) -> None:
    global _settings
    _settings = AutoUnloadSettings.model_validate(value.model_dump())
    if not _settings.enabled:
        _tracks.clear()


def busy_printer_ids() -> set[int]:
    """Printers being unloaded, or checked just before it."""
    return set(_busy)


def is_busy(printer_id: int) -> bool:
    return printer_id in _busy


# ---------------------------------------------------------------- checks


def _queue_sending_to(printer_id: int) -> bool:
    from backend.app.hyyz17200.calibration_batch import _queue_sending_to

    return _queue_sending_to(printer_id)


def _keeping_warm(printer_id: int) -> bool:
    """The scheduler holds the bed warm because a job is about to come
    (test_hyyz17200_auto_unload fails if upstream renames it)."""
    from backend.app.services.print_scheduler import scheduler

    return printer_id in (getattr(scheduler, "_keep_warm", None) or {})


def _ams_units(state: object) -> list:
    raw = getattr(state, "raw_data", None)
    units = raw.get("ams") if isinstance(raw, Mapping) else None
    if isinstance(units, Mapping):
        units = units.get("ams")
    return units if isinstance(units, list) else []


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _slot_holds_spool(state: object, layout: object, tray_id: int) -> bool:
    """The AMS reports a filament type in the slot the toolhead is fed from."""
    ams_id, slot = layout.slot_key(tray_id)
    for unit in _ams_units(state):
        if not isinstance(unit, Mapping) or _as_int(unit.get("id")) != ams_id:
            continue
        for tray in unit.get("tray") or []:
            if isinstance(tray, Mapping) and _as_int(tray.get("id")) == slot:
                return bool(tray.get("tray_type"))
    return False


def _why_not(printer_id: int, client: object, state: object) -> str | None:
    """Why the printer cannot be unloaded now, or None. Memory only: it runs
    for every printer on every pass."""
    from backend.app.services.firmware_update import upload_in_progress

    if client is None or state is None or not getattr(state, "connected", False):
        return "offline"
    if (state.state or "").upper() not in IDLE_STATES:
        return "not_idle"
    if getattr(client, "_is_dual_nozzle", False):
        return "dual_nozzle"
    layout = client.tray_layout
    if layout.rack_units:
        return "ams_3h"
    tray = state.tray_now
    if tray in (NOTHING_LOADED, EXTERNAL_SPOOL) or layout.is_external(tray) or not layout.is_loaded_tray(tray):
        return "not_from_ams"
    if not _slot_holds_spool(state, layout, tray):
        return "slot_empty"
    if state.ams_status_main != 0:
        return "ams_busy"
    if printer_manager.get_drying_targets(printer_id):
        return "drying"
    if hms_filter.visible_faults(state.hms_errors):
        return "fault"
    if upload_in_progress(printer_id):
        return "firmware_upload"
    if _queue_sending_to(printer_id):
        return "queue_sending"
    if _keeping_warm(printer_id):
        return "keep_warm"
    return None


async def _in_calibration_batch(printer_id: int) -> bool:
    from backend.app.hyyz17200.calibration_batch import OPEN
    from backend.app.hyyz17200.models.calibration import CalibrationBatch, CalibrationItem

    async with database.async_session() as db:
        found = await db.scalar(
            select(CalibrationItem.id)
            .join(CalibrationBatch, CalibrationBatch.id == CalibrationItem.batch_id)
            .where(
                CalibrationBatch.status == "running",
                CalibrationItem.printer_id == printer_id,
                CalibrationItem.status.in_(OPEN),
            )
            .limit(1)
        )
    return found is not None


# ---------------------------------------------------------------- the pass


async def tick() -> None:
    """One pass over the printers: start the unloads that are due."""
    if not _settings.enabled:
        _tracks.clear()
        return
    now = time.monotonic()
    idle_seconds = _settings.idle_minutes * 60
    statuses = printer_manager.get_all_statuses()
    for printer_id in [pid for pid in _tracks if pid not in statuses]:
        del _tracks[printer_id]

    due: list[int] = []
    for printer_id, state in statuses.items():
        client = printer_manager.get_client(printer_id)
        if client is None or not state.connected:
            _tracks.pop(printer_id, None)
            continue
        gcode_state = (state.state or "").upper()
        key = (gcode_state, state.tray_now, state.ams_status_main)
        track = _tracks.get(printer_id)
        if track is None or track.client is not client:
            _tracks[printer_id] = _Track(client=client, key=key, since=now)
            continue
        if gcode_state in ACTIVE_STATES:
            track.tried = False
            track.refresh_failures = 0
        if key != track.key:
            track.key = key
            track.since = now
            continue
        if track.tried or printer_id in _attempts or now - track.since < idle_seconds:
            continue
        if _why_not(printer_id, client, state) is None:
            due.append(printer_id)

    for printer_id in due:
        try:
            if await _in_calibration_batch(printer_id):
                continue
        except Exception:
            logger.warning("hyyz17200 auto unload: printer %s calibration check failed", printer_id, exc_info=True)
            continue
        track = _tracks[printer_id]
        track.tried = True
        _attempts[printer_id] = spawn_background_task(
            _attempt(printer_id, track), name=f"hyyz17200-auto-unload-{printer_id}"
        )


async def _refresh(client: object) -> bool:
    """Ask for a full report and wait until one has been taken in."""
    seen: list[bool] = []

    def on_report(topic: str, payload: bytes) -> None:
        # paho's network thread: cheap, and never raises.
        if seen or not topic.endswith("/report") or b'"ams"' not in payload:
            return
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        report = data.get("print") if isinstance(data, dict) else None
        if isinstance(report, dict) and "ams" in report and len(report) > FULL_REPORT_KEYS:
            seen.append(True)

    client.register_raw_message_handler(on_report)
    try:
        if not client.request_status_update():
            return False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + REFRESH_TIMEOUT_SECONDS
        while not seen and loop.time() < deadline:
            await asyncio.sleep(0.2)
    finally:
        client.unregister_raw_message_handler(on_report)
    if seen:
        await asyncio.sleep(REPORT_SETTLE_SECONDS)
    return bool(seen)


def _label(client: object, printer_id: int) -> str:
    return f"{printer_id} ({getattr(client, 'serial_number', '?')})"


async def _attempt(printer_id: int, track: _Track) -> None:
    client = track.client
    label = _label(client, printer_id)
    _busy[printer_id] = time.monotonic()
    try:
        tray = client.state.tray_now
        if not await _refresh(client):
            track.refresh_failures += 1
            if track.refresh_failures < REFRESH_TRIES:
                track.tried = False
            logger.info(
                "hyyz17200 auto unload: printer %s did not answer the refresh (%s of %s)",
                label,
                track.refresh_failures,
                REFRESH_TRIES,
            )
            return
        if printer_manager.get_client(printer_id) is not client:
            logger.info("hyyz17200 auto unload: printer %s reconnected meanwhile; not unloading", label)
            return
        state = client.state
        if state.tray_now != tray:
            logger.info(
                "hyyz17200 auto unload: printer %s reports slot %s loaded, not %s; not unloading",
                label,
                state.tray_now,
                tray,
            )
            return
        reason = _why_not(printer_id, client, state)
        if reason is not None:
            logger.info("hyyz17200 auto unload: printer %s not unloaded after the refresh: %s", label, reason)
            return
        if not client.ams_unload_filament(tray):
            logger.info("hyyz17200 auto unload: printer %s could not be sent the unload", label)
            return
        logger.info(
            "hyyz17200 auto unload: printer %s unloading slot %s after %s idle minutes",
            label,
            tray,
            _settings.idle_minutes,
        )
        await _follow(printer_id, client, label)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("hyyz17200 auto unload: printer %s attempt failed", label)
    finally:
        _busy.pop(printer_id, None)
        _attempts.pop(printer_id, None)


async def _follow(printer_id: int, client: object, label: str) -> None:
    """Wait for the unload to end, and log how it went."""
    started = time.monotonic()
    seen_unloading = False
    hottest_target = 0.0
    while True:
        await asyncio.sleep(FOLLOW_SECONDS)
        elapsed = time.monotonic() - started
        if elapsed >= UNLOAD_TIMEOUT_SECONDS:
            break
        if printer_manager.get_client(printer_id) is not client or not client.state.connected:
            logger.info("hyyz17200 auto unload: printer %s went offline after %.0fs", label, elapsed)
            return
        state = client.state
        try:
            hottest_target = max(hottest_target, float(state.temperatures.get("nozzle_target") or 0))
        except (TypeError, ValueError):
            pass
        if state.ams_status_main != 0:
            seen_unloading = True
        if (state.state or "").upper() in ACTIVE_STATES:
            logger.info("hyyz17200 auto unload: printer %s started a print after %.0fs", label, elapsed)
            return
        if (
            state.tray_now == NOTHING_LOADED
            and state.ams_status_main == 0
            and (seen_unloading or elapsed >= UNSEEN_UNLOAD_SECONDS)
        ):
            logger.info(
                "hyyz17200 auto unload: printer %s unloaded in %.0fs (nozzle target up to %.0f °C)",
                label,
                elapsed,
                hottest_target,
            )
            return
    state = client.state
    logger.warning(
        "hyyz17200 auto unload: printer %s not unloaded after %ss: slot %s loaded, AMS status %s, faults %s",
        label,
        UNLOAD_TIMEOUT_SECONDS,
        state.tray_now,
        state.ams_status,
        [getattr(e, "full_code", e) for e in state.hms_errors or []],
    )


class _Runner:
    """The background loop, run inside the app's lifespan (__init__.py)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-auto-unload")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
        for task in list(_attempts.values()):
            task.cancel()
        _attempts.clear()
        _busy.clear()

    async def _run(self) -> None:
        while True:
            try:
                await tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("hyyz17200 auto unload: pass failed")
            await asyncio.sleep(POLL_SECONDS)


runner = _Runner()
