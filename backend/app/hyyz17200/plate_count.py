"""Plate count: stop sending jobs to a printer whose plate changer has run out of clean plates.

A printer with a plate changer holds a stack of plates (10 on the farm's A1s,
the one on the bed included) and swaps in the next one at the end of each job.
Once the stack is used up the next job prints on an empty bed, and the
printer's own detection does not always catch it. Someone collects the
finished plates about once a day; short jobs can use the stack up before that.

So each counted printer has a number of clean plates. A queue job that finishes
takes one off; a failed or cancelled one does not (the plate stays on the bed,
and whoever deals with it puts a usable one back). When none is left the queue
sends the printer nothing more, the way "Stop taking jobs" does, until someone
refills it from the card (to full, or a number from the card menu) or from the
printers page's multi-select toolbar. Time never refills it: only a person who
has been to the printer knows the plates were collected.

Only printers that swap their own plates are counted: those the plate-clear
confirmation does not apply to (upstream's per-printer setting, #2860). Where
it applies (a P1 cleared by hand) the printer is never counted, whatever it is
set to here. A counted printer can be switched off, and have its own capacity.

How a job is counted. Every queue dispatch gets a new ``billing_run_id`` from
upstream as the job moves to "printing", and the job ends as "completed",
"failed" or "cancelled" (or goes back to "pending" when the watchdog sees it
never started). Rather than hooking those writes, which upstream makes in many
places, this reads the queue table:

- A run still printing holds its plate: the printer can start nothing else
  until it finishes, so ``plates - runs printing <= 0`` holds the printer. That
  includes the moment the printer reports FINISH before upstream marks the job
  completed: the run still counts as printing, so the next job never slips in.
- :func:`settle` (the background loop, and before every refill) takes one plate
  off for each completed run it has not seen, and records the run in
  ``hyyz17200_plate_run`` so it never counts twice. Completed runs are looked
  for within COMPLETED_WINDOW, so one that finished while Bambuddy was down is
  still counted after the restart.
- A refill sets the number of plates in the machine. A run printing at the time
  keeps its plate and takes it off when it finishes, which is right: the plate
  it prints on was counted in the refill.

Jobs Bambu Studio or Handy send straight to the printer are not counted or
held: Bambuddy never sees them as jobs.
"""

import asyncio
import logging
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200.models.plate_count import PlatePrinter, PlateRun
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services import plate_clear

logger = logging.getLogger(__name__)

SECTION = "plate_count"
POLL_SECONDS = 10
MAX_CAPACITY = 99
# Completed jobs looked at for a plate to take off. One that finished longer ago
# than this without being seen (Bambuddy down for days) is not counted.
COMPLETED_WINDOW = timedelta(days=3)
# Runs remembered, longer than the window so none is counted twice.
RUN_RETENTION = timedelta(days=7)
COUNTED = "counted"
EXEMPT = "exempt"


class PlateCountSettings(BaseModel):
    """The Enhanced Settings' plate count section."""

    enabled: bool = False
    default_capacity: int = Field(default=10, ge=1, le=MAX_CAPACITY)


_settings = PlateCountSettings()
# Printers held for want of a clean plate, from the last look. For the waiting
# reason and the log; the queue asks held_printer_ids() itself.
_held: frozenset[int] = frozenset()
_locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}


def apply_settings(value: BaseModel) -> None:
    global _settings
    _settings = PlateCountSettings.model_validate(value.model_dump())


def is_enabled() -> bool:
    return _settings.enabled


def is_held(printer_id: int) -> bool:
    return printer_id in _held


def _lock() -> asyncio.Lock:
    """One lock per event loop: tests run several, and a lock belongs to one."""
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = _locks[loop] = asyncio.Lock()
    return lock


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def capacity_of(own: int | None) -> int:
    return own if own else _settings.default_capacity


def applicable(printer_id: int, plate_clear_setting: bool) -> bool:
    """Swaps its own plates: the plate-clear confirmation does not apply to it."""
    return not plate_clear.applies(printer_id, plate_clear_setting)


def counted(printer_id: int, disabled: bool, plate_clear_setting: bool) -> bool:
    return _settings.enabled and applicable(printer_id, plate_clear_setting) and not disabled


async def plate_clear_setting(db: AsyncSession) -> bool:
    """Upstream's app-wide "Require plate-clear confirmation"."""
    value = await db.scalar(select(Settings.value).where(Settings.key == "require_plate_clear"))
    return (value or "").strip().lower() == "true"


@dataclass
class _Run:
    queue_item_id: int
    printer_id: int
    run_id: str
    status: str
    exempt: bool


async def _unseen_runs(db: AsyncSession, since: dict[int, datetime | None]) -> dict[int, list[_Run]]:
    """Per counted printer (``since``: printer -> counting_since), its runs
    printing or completed that no plate has been taken off for yet. Read only."""
    if not since:
        return {}
    cutoff = _now() - COMPLETED_WINDOW
    items = (
        await db.execute(
            select(
                PrintQueueItem.id,
                PrintQueueItem.printer_id,
                PrintQueueItem.billing_run_id,
                PrintQueueItem.status,
                PrintQueueItem.started_at,
            ).where(
                PrintQueueItem.printer_id.in_(list(since)),
                PrintQueueItem.billing_run_id.is_not(None),
                or_(
                    PrintQueueItem.status == "printing",
                    and_(PrintQueueItem.status == "completed", PrintQueueItem.completed_at >= cutoff),
                ),
            )
        )
    ).all()
    if not items:
        return {}
    run_ids = [item.billing_run_id for item in items]
    known = set(
        (await db.execute(select(PlateRun.billing_run_id).where(PlateRun.billing_run_id.in_(run_ids)))).scalars()
    )
    exempt = set(
        (
            await db.execute(
                select(PlateRun.queue_item_id).where(
                    PlateRun.kind == EXEMPT,
                    PlateRun.billing_run_id.is_(None),
                    PlateRun.queue_item_id.in_([item.id for item in items]),
                )
            )
        ).scalars()
    )
    runs: dict[int, list[_Run]] = defaultdict(list)
    for item in items:
        if item.billing_run_id in known:
            continue
        start = since.get(item.printer_id)
        started = _naive(item.started_at)
        if start is not None and started is not None and started < start:
            continue
        runs[item.printer_id].append(
            _Run(item.id, item.printer_id, item.billing_run_id, item.status, item.id in exempt)
        )
    return runs


def _in_use(runs: Iterable[_Run]) -> int:
    """Plates the printer's runs hold: printing, or completed and not yet taken off."""
    return sum(1 for run in runs if not run.exempt)


def _record_held(held: set[int]) -> None:
    global _held
    for printer_id in held - _held:
        logger.info("hyyz17200 plate count: printer %s has no clean plate left; the queue skips it", printer_id)
    for printer_id in _held - held:
        logger.info("hyyz17200 plate count: printer %s has clean plates again", printer_id)
    _held = frozenset(held)


async def _counted_rows(db: AsyncSession) -> list[tuple[int, int, datetime | None]]:
    """(printer, plates, counting_since) of the printers counted right now."""
    if not _settings.enabled:
        return []
    setting = await plate_clear_setting(db)
    rows = (
        await db.execute(
            select(PlatePrinter.printer_id, PlatePrinter.plates, PlatePrinter.counting_since, PlatePrinter.disabled)
            .join(Printer, Printer.id == PlatePrinter.printer_id)
            .where(PlatePrinter.plates.is_not(None))
        )
    ).all()
    # Checked again here, not only by settle(): a printer the confirmation now
    # applies to is let go at once, without waiting for the loop.
    return [(pid, plates, since) for pid, plates, since, disabled in rows if counted(pid, disabled, setting)]


async def held_printer_ids(db: AsyncSession) -> set[int]:
    """Printers the queue skips for want of a clean plate. Called by
    printer_intake.queue_skipped_printer_ids on every queue pass, inside the
    scheduler's own session, so it only reads."""
    rows = await _counted_rows(db)
    runs = await _unseen_runs(db, {pid: since for pid, _plates, since in rows})
    held = {pid for pid, plates, _since in rows if plates - _in_use(runs.get(pid, ())) <= 0}
    _record_held(held)
    return held


async def _counting_start(db: AsyncSession, printer_id: int, now: datetime) -> datetime:
    """Now, or when the job printing now started: its plate is one of the stack."""
    started = await db.scalar(
        select(PrintQueueItem.started_at).where(
            PrintQueueItem.printer_id == printer_id, PrintQueueItem.status == "printing"
        )
    )
    started = _naive(started)
    return min(started, now) if started else now


async def _settle(db: AsyncSession) -> None:
    rows = {row.printer_id: row for row in (await db.execute(select(PlatePrinter))).scalars()}
    if not _settings.enabled:
        changed = False
        for row in rows.values():
            if row.plates is not None:
                row.plates = row.counting_since = None
                changed = True
        if changed or await db.scalar(select(PlateRun.id).limit(1)) is not None:
            await db.execute(delete(PlateRun))
            await db.commit()
        _record_held(set())
        return

    setting = await plate_clear_setting(db)
    now = _now()
    stopped: list[int] = []
    for printer_id in (await db.execute(select(Printer.id))).scalars():
        row = rows.get(printer_id)
        if counted(printer_id, bool(row and row.disabled), setting):
            if row is None:
                row = rows[printer_id] = PlatePrinter(printer_id=printer_id, disabled=False)
                db.add(row)
            capacity = capacity_of(row.capacity)
            if row.plates is None:
                row.plates = capacity
                row.counting_since = await _counting_start(db, printer_id, now)
                row.updated_at, row.updated_by = now, None
                logger.info("hyyz17200 plate count: counting printer %s from a full stack of %s", printer_id, capacity)
            elif row.plates > capacity:
                row.plates = capacity
        elif row is not None and row.plates is not None:
            row.plates = row.counting_since = None
            stopped.append(printer_id)
            logger.info("hyyz17200 plate count: no longer counting printer %s", printer_id)
    if stopped:
        await db.execute(delete(PlateRun).where(PlateRun.printer_id.in_(stopped), PlateRun.kind == COUNTED))
    await db.flush()

    counting = {pid: row for pid, row in rows.items() if row.plates is not None}
    runs = await _unseen_runs(db, {pid: row.counting_since for pid, row in counting.items()})
    for printer_id, printer_runs in runs.items():
        row = counting[printer_id]
        for run in printer_runs:
            if run.exempt:
                await db.execute(
                    update(PlateRun)
                    .where(
                        PlateRun.kind == EXEMPT,
                        PlateRun.queue_item_id == run.queue_item_id,
                        PlateRun.billing_run_id.is_(None),
                    )
                    .values(billing_run_id=run.run_id)
                )
            elif run.status == "completed":
                row.plates = max(0, row.plates - 1)
                db.add(
                    PlateRun(
                        printer_id=printer_id, queue_item_id=run.queue_item_id, billing_run_id=run.run_id, kind=COUNTED
                    )
                )
                logger.info(
                    "hyyz17200 plate count: printer %s finished queue job %s, %s clean plates left",
                    printer_id,
                    run.queue_item_id,
                    row.plates,
                )
    await db.execute(delete(PlateRun).where(PlateRun.created_at < now - RUN_RETENTION))
    await db.commit()

    held = {
        pid
        for pid, row in counting.items()
        if row.plates - sum(1 for run in runs.get(pid, ()) if not run.exempt and run.status == "printing") <= 0
    }
    _record_held(held)


async def settle(db: AsyncSession) -> None:
    """Start and stop counting printers as their settings say, and take a plate
    off for every completed job not yet counted."""
    async with _lock():
        await _settle(db)


class NotCounted(Exception):
    """The printer is not counted, so it has no plates to set."""


async def set_plates(db: AsyncSession, printer_ids: Iterable[int], plates: int | None, by: str | None) -> list[int]:
    """Set the clean plates in each printer: ``plates`` (no more than its
    capacity), or a full stack for None. Returns the printers set; the ones not
    counted are left out. Completed jobs are counted first, so a job that
    finished just before the refill does not take a plate off the new stack."""
    async with _lock():
        await _settle(db)
        ids = list(dict.fromkeys(printer_ids))
        rows = (await db.execute(select(PlatePrinter).where(PlatePrinter.printer_id.in_(ids)))).scalars().all()
        now = _now()
        done = []
        for row in rows:
            if row.plates is None:
                continue
            capacity = capacity_of(row.capacity)
            row.plates = capacity if plates is None else max(0, min(plates, capacity))
            row.updated_at, row.updated_by = now, by
            done.append(row.printer_id)
            logger.info(
                "hyyz17200 plate count: printer %s set to %s clean plates by %s", row.printer_id, row.plates, by
            )
        await db.commit()
        await _settle(db)
        return done


async def configure(
    db: AsyncSession, printer_ids: Iterable[int], *, disabled: bool | None, capacity: int | None, default_capacity: bool
) -> None:
    """Switch printers off or on here, and set (or clear, with
    ``default_capacity``) their own capacity. Counting starts or stops at once."""
    async with _lock():
        ids = list(dict.fromkeys(printer_ids))
        rows = {
            row.printer_id: row
            for row in (await db.execute(select(PlatePrinter).where(PlatePrinter.printer_id.in_(ids)))).scalars()
        }
        for printer_id in ids:
            row = rows.get(printer_id)
            if row is None:
                row = PlatePrinter(printer_id=printer_id, disabled=False)
                db.add(row)
            if disabled is not None:
                row.disabled = disabled
            if default_capacity:
                row.capacity = None
            elif capacity is not None:
                row.capacity = capacity
        await db.commit()
        await _settle(db)


async def exempt(db: AsyncSession, queue_item_id: int, printer_id: int) -> None:
    """A maintenance G-code job that does not use a plate. Called before it is sent."""
    db.add(PlateRun(printer_id=printer_id, queue_item_id=queue_item_id, kind=EXEMPT))
    await db.commit()


async def overview(db: AsyncSession, allows: Callable[[int], bool]) -> dict:
    """The feature's settings and, per printer the caller may see, whether it is
    counted and how many plates it has. Read only."""
    setting = await plate_clear_setting(db)
    rows = {row.printer_id: row for row in (await db.execute(select(PlatePrinter))).scalars()}
    printer_ids = [pid for pid in (await db.execute(select(Printer.id))).scalars() if allows(pid)]
    counting = {
        pid: rows[pid].counting_since
        for pid in printer_ids
        if pid in rows and rows[pid].plates is not None and counted(pid, rows[pid].disabled, setting)
    }
    runs = await _unseen_runs(db, counting)
    printers = []
    for printer_id in printer_ids:
        row = rows.get(printer_id)
        own = row.capacity if row else None
        entry = {
            "printer_id": printer_id,
            "applicable": applicable(printer_id, setting),
            "disabled": bool(row and row.disabled),
            "capacity": own,
            "effective_capacity": capacity_of(own),
            "counted": printer_id in counting,
            "plates": None,
            "in_use": 0,
            "available": None,
            "held": False,
            "updated_at": row.updated_at if row else None,
            "updated_by": row.updated_by if row else None,
        }
        if printer_id in counting:
            in_use = _in_use(runs.get(printer_id, ()))
            entry.update(plates=row.plates, in_use=in_use, available=max(0, row.plates - in_use))
            entry["held"] = row.plates - in_use <= 0
        printers.append(entry)
    return {
        "enabled": _settings.enabled,
        "default_capacity": _settings.default_capacity,
        "plate_clear_setting": setting,
        "printers": printers,
    }


class _Runner:
    """The background loop, run inside the app's lifespan (__init__.py)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-plate-count")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                async with database.async_session() as db:
                    await settle(db)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("hyyz17200 plate count: counting plates failed")
            await asyncio.sleep(POLL_SECONDS)


runner = _Runner()
