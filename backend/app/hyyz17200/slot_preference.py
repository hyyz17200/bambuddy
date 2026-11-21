"""Among identical spools, use the slot already loaded, else the one loaded last.

Upstream maps each filament a job needs to an AMS slot by match quality, and
among equally good slots takes the first in slot order. With two identical
spools (two slots set up for AMS filament backup), that is always the lower
slot. Where the filament left in the toolhead is the other one, the print
starts with a filament change, and the two spools are used up in turns rather
than one after the other.

This changes only that tie. Upstream maps the job as before, and then a slot
it picked is swapped for the preferred slot when the two hold the same spool:
same material, colour and filament preset (``tray_info_idx``), on the same
nozzle. Nothing else about the mapping changes, so a job never gets a
different filament, and a multi-colour job's other slots stay where upstream
put them.

The preferred slot is, in order:

- the slot loaded now (``tray_now``);
- with nothing loaded (the end-of-print retract, or auto_unload.py), the slot
  loaded last: upstream's in-memory ``last_loaded_tray``, then this module's
  copy of it in ``hyyz17200_printer_last_tray``, which survives a restart.

Only AMS slots count; the external spool has no backup to keep going.

Both of the scheduler's mapping paths are wrapped (:func:`install`):

- ``_compute_ams_mapping_for_printer``: every mapping the backend works out,
  at dispatch for "any <model>" jobs, and for maintenance G-code and the
  filament checks;
- ``_settle_ams_mapping``: a mapping the print dialog stored with a job aimed
  at one printer, kept by upstream at dispatch when it still fits.

Off when upstream's "Prefer lowest remaining filament" applies to the printer
(the setting is on and the printer's AMS filament backup is not off): that
setting already decides between identical spools.
"""

import asyncio
import json
import logging
from collections.abc import Iterable, Mapping

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200.models.printer_last_tray import PrinterLastTray
from backend.app.models.printer import Printer
from backend.app.services.printer_manager import printer_manager
from backend.app.utils.filament_types import canonical_filament_type

logger = logging.getLogger(__name__)

SECTION = "slot_preference"
POLL_SECONDS = 30
# Global tray ids from here up are the external spools (254, 255 = nothing loaded).
FIRST_EXTERNAL_TRAY = 254


class SlotPreferenceSettings(BaseModel):
    """The Enhanced Settings' slot preference section."""

    enabled: bool = False


_settings = SlotPreferenceSettings()
# printer_id -> tray last written to the table, so unchanged ones are not rewritten.
_written: dict[int, int] = {}


def apply_settings(value: BaseModel) -> None:
    global _settings
    _settings = SlotPreferenceSettings.model_validate(value.model_dump())


def is_enabled() -> bool:
    return _settings.enabled


def _is_slot(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < FIRST_EXTERNAL_TRAY


def _norm_color(value: object) -> str:
    text = str(value or "").lstrip("#").upper()
    return text[:6]


def same_spool(a: Mapping, b: Mapping) -> bool:
    """Whether two ``_build_loaded_filaments`` entries hold the same filament."""
    if a.get("is_external") or b.get("is_external"):
        return False
    if canonical_filament_type((a.get("type") or "").upper()) != canonical_filament_type((b.get("type") or "").upper()):
        return False
    if bool(a.get("color_known", True)) != bool(b.get("color_known", True)):
        return False
    if _norm_color(a.get("color")) != _norm_color(b.get("color")):
        return False
    if (a.get("tray_info_idx") or "") != (b.get("tray_info_idx") or ""):
        return False
    return a.get("extruder_id") == b.get("extruder_id")


def prefer(
    mapping: object,
    loaded: Iterable[Mapping],
    tray: int | None,
    reserved: Iterable[int] = (),
) -> list | None:
    """``mapping`` with one slot moved to ``tray``, or None when nothing changes.

    The first slot mapped to a tray holding the same spool as ``tray`` moves.
    Nothing moves when ``tray`` is not a loaded AMS slot, is already in the
    mapping, or is ``reserved`` (another part of the mapping has it).
    """
    if not isinstance(mapping, list) or not _is_slot(tray) or tray in set(reserved):
        return None
    by_id = {f.get("global_tray_id"): f for f in loaded if not f.get("is_external")}
    wanted = by_id.get(tray)
    if wanted is None or any(_is_slot(t) and t == tray for t in mapping):
        return None
    for index, current in enumerate(mapping):
        if not _is_slot(current):
            continue
        have = by_id.get(current)
        if have is not None and same_spool(have, wanted):
            result = list(mapping)
            result[index] = tray
            return result
    return None


async def preferred_tray(db: AsyncSession, printer_id: int, state: object) -> tuple[int | None, str]:
    """The slot to prefer on this printer, and why ("loaded" or "last loaded")."""
    tray_now = getattr(state, "tray_now", None)
    if _is_slot(tray_now):
        return tray_now, "loaded"
    last = getattr(state, "last_loaded_tray", None)
    if _is_slot(last):
        return last, "last loaded"
    row = await db.get(PrinterLastTray, printer_id)
    if row is not None and _is_slot(row.tray):
        return row.tray, "last loaded before a restart"
    return None, ""


async def _prefer_lowest_applies(db: AsyncSession, scheduler: object, state: object) -> bool:
    """Upstream's "Prefer lowest remaining filament", gated the way upstream gates it."""
    try:
        on = await scheduler._get_bool_setting(db, "prefer_lowest_filament")
    except Exception:
        return False
    return bool(on) and getattr(state, "ams_filament_backup", None) is not False


async def preferred_mapping(
    db: AsyncSession, printer_id: int, mapping: object, reserved: Iterable[int] = ()
) -> list | None:
    """``mapping`` for this printer with the preferred slot swapped in, or None."""
    if not _settings.enabled or not isinstance(mapping, list) or not mapping:
        return None
    from backend.app.services.print_scheduler import scheduler

    state = printer_manager.get_status(printer_id)
    if state is None or await _prefer_lowest_applies(db, scheduler, state):
        return None
    tray, why = await preferred_tray(db, printer_id, state)
    if tray is None:
        return None
    result = prefer(mapping, scheduler._build_loaded_filaments(state), tray, reserved)
    if result is not None:
        logger.info(
            "hyyz17200 slot preference: printer %s: mapping %s -> %s (tray %s %s)",
            printer_id,
            mapping,
            result,
            tray,
            why,
        )
    return result


def install() -> None:
    """Wrap the scheduler's two mapping paths. Idempotent."""
    from backend.app.services.print_scheduler import scheduler

    compute = scheduler._compute_ams_mapping_for_printer
    if getattr(compute, "hyyz17200", False) is not True:

        async def compute_ams_mapping_for_printer(db, printer_id, item, *args, **kwargs):
            mapping = await compute(db, printer_id, item, *args, **kwargs)
            try:
                preferred = await preferred_mapping(db, printer_id, mapping, kwargs.get("reserved_trays") or ())
            except Exception:
                logger.exception("hyyz17200 slot preference: printer %s: could not apply", printer_id)
                return mapping
            return preferred if preferred is not None else mapping

        compute_ams_mapping_for_printer.hyyz17200 = True
        scheduler._compute_ams_mapping_for_printer = compute_ams_mapping_for_printer

    settle = scheduler._settle_ams_mapping
    if getattr(settle, "hyyz17200", False) is not True:

        async def settle_ams_mapping(db, printer_id, item, *args, **kwargs):
            result = await settle(db, printer_id, item, *args, **kwargs)
            if result is None and item.ams_mapping:
                try:
                    preferred = await preferred_mapping(db, printer_id, json.loads(item.ams_mapping))
                    if preferred is not None:
                        item.ams_mapping = json.dumps(preferred)
                        await db.commit()
                except Exception:
                    logger.exception("hyyz17200 slot preference: printer %s: could not apply", printer_id)
            return result

        settle_ams_mapping.hyyz17200 = True
        scheduler._settle_ams_mapping = settle_ams_mapping


async def record() -> None:
    """Write each printer's ``last_loaded_tray`` that changed since last written."""
    if not _settings.enabled:
        return
    changed = {
        printer_id: state.last_loaded_tray
        for printer_id, state in printer_manager.get_all_statuses().items()
        if _is_slot(getattr(state, "last_loaded_tray", None)) and _written.get(printer_id) != state.last_loaded_tray
    }
    if not changed:
        return
    async with database.async_session() as db:
        existing = set((await db.scalars(select(Printer.id).where(Printer.id.in_(changed)))).all())
        for printer_id in existing:
            row = await db.get(PrinterLastTray, printer_id)
            if row is None:
                db.add(PrinterLastTray(printer_id=printer_id, tray=changed[printer_id]))
            else:
                row.tray = changed[printer_id]
        await db.commit()
    for printer_id in existing:
        _written[printer_id] = changed[printer_id]


class _Runner:
    """The background loop, run inside the app's lifespan (__init__.py)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-slot-preference")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await record()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("hyyz17200 slot preference: recording the loaded slots failed")
            await asyncio.sleep(POLL_SECONDS)


runner = _Runner()
