"""Maintenance G-code: send one sliced file to one printer, now.

The card menu's "Send maintenance G-code" lists the sliced files under a library
folder chosen in Enhanced Settings (subfolders included) and sends the one
picked. It goes out at once, whether or not the printer is taking jobs and
whatever else is waiting in the queue.

It is still an ordinary queue job, so the archive, statistics, the plate-clear
flag and every check upstream's ``_start_print`` makes (nozzle size, the busy
guard, the upload, the watchdog) stay upstream's. What it skips is the queue
pass that would pick it: the job is created with ``manual_start`` so no pass
ever picks it, and this module hands it straight to the scheduler's dispatch
worker (``_dispatch_one``), registered in ``_inflight`` the way a pass would.
That pass is where the "stop taking jobs" hold lives, along with the queue
order, the 30 s tick and the filament checks, none of which apply here.

Two things a pass would do are done here instead:

- the readiness check: connected, idle, no queue job on its way, not unloading,
  not drying, no Home Assistant interlock. A printer that is not ready refuses
  the send rather than holding it, because a held maintenance job would go out
  whenever the printer next came free;
- the AMS mapping, computed by the scheduler's own function. When nothing
  matches the job goes out without one.

A send and a queue pass never run at the same time (:func:`install` wraps
``check_queue`` in the same lock). Otherwise a pass that had already counted
the printer as free could send it a queue job while this upload runs.

A job that was not started is closed as failed, not left pending: it sits at
the top of the queue, and a pending job there would print the next time
anything started it.

``clears_plate`` is the per-file "plate is clear afterwards" switch. On, the
job is recorded like a plate swap (plate_swap.record_dispatch), so its
completion skips the plate-clear check. Off, the completion asks as usual.
Nothing about the file's G-code is checked: what it does is the user's choice.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200 import calibration_batch, plate_swap
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.utils.printer_models import is_gcode_compatible

logger = logging.getLogger(__name__)

SECTION = "maintenance"
SLICED_SUFFIX = ".gcode.3mf"
# How long a send waits for a queue pass to finish before giving up.
LOCK_TIMEOUT_SECONDS = 30
NOT_SENT_MESSAGE = "Maintenance G-code was not sent. Check the printer and send it again."


class MaintenanceSettings(BaseModel):
    # The library folder whose sliced files (subfolders included) are offered.
    folder_id: int | None = None


_locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}


def _lock() -> asyncio.Lock:
    """One lock per event loop: tests run several, and a lock belongs to one."""
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = _locks[loop] = asyncio.Lock()
    return lock


def install() -> None:
    """Run every queue pass under the send lock. Idempotent."""
    from backend.app.services.print_scheduler import scheduler

    current = scheduler.check_queue
    if getattr(current, "hyyz17200", False) is True:
        return

    async def check_queue() -> bool:
        async with _lock():
            return await current()

    check_queue.hyyz17200 = True
    scheduler.check_queue = check_queue


async def in_folder(db: AsyncSession, folder_id: int, file_folder_id: int | None) -> bool:
    """Whether a file in ``file_folder_id`` sits under ``folder_id``, at any depth."""
    seen: set[int] = set()
    current = file_folder_id
    while current is not None and current not in seen:
        if current == folder_id:
            return True
        seen.add(current)
        current = await db.scalar(select(LibraryFolder.parent_id).where(LibraryFolder.id == current))
    return False


async def blocker(db: AsyncSession, printer: Printer | None) -> str | None:
    """Why the printer cannot take a maintenance job now, or None.

    The plate-clear flag is left out: a maintenance job is often the plate swap
    that answers it.
    """
    reason = calibration_batch._blocker(printer, require_plate_clear=False)
    if reason is not None:
        return reason
    from backend.app.services.ha_sensor_manager import ha_sensor_manager
    from backend.app.services.print_scheduler import scheduler

    drying = getattr(scheduler, "_drying_in_progress", {})
    parked = getattr(scheduler, "_drying_is_only_parked", None)
    if drying.get(printer.id) and not (parked and parked(printer.id)):
        return "drying"
    try:
        interlocked = await ha_sensor_manager.blocked_printers(db)
    except Exception:
        logger.warning("hyyz17200: could not read the Home Assistant interlocks", exc_info=True)
        interlocked = {}
    if printer.id in interlocked:
        return "interlock"
    return None


def _refuse(code: str, status_code: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(status_code=status_code, detail=code)


async def send(
    db: AsyncSession,
    printer_id: int,
    library_file_id: int,
    clears_plate: bool,
    *,
    current_user: Any,
    printer_scope: Any,
    review_required: bool,
    actor: Any,
) -> int:
    """Create the job through upstream's queue route and start its dispatch.

    Returns the queue item id once the upload is under way. Raises an
    HTTPException whose ``detail`` is a short code when the send is refused.
    """
    from backend.app.api.routes.print_queue import add_to_queue
    from backend.app.hyyz17200 import enhanced_settings
    from backend.app.schemas.print_queue import PrintQueueItemCreate

    # A job that would wait for review is not "now", and starting it here
    # would skip the review.
    if review_required:
        raise _refuse("review_required", status.HTTP_403_FORBIDDEN)

    printer = await db.get(Printer, printer_id)
    if printer is None or not printer_scope.allows(printer_id):
        raise _refuse("printer_not_found", status.HTTP_404_NOT_FOUND)

    settings = await enhanced_settings.read_section(db, SECTION)
    if settings.folder_id is None:
        raise _refuse("no_folder", status.HTTP_400_BAD_REQUEST)

    library_file = await db.get(LibraryFile, library_file_id)
    if library_file is None or library_file.deleted_at is not None:
        raise _refuse("file_not_found", status.HTTP_404_NOT_FOUND)
    if not await in_folder(db, settings.folder_id, library_file.folder_id):
        raise _refuse("not_in_folder", status.HTTP_400_BAD_REQUEST)
    # Read now: a failed AMS match below rolls the session back, which expires it.
    filename = library_file.filename
    if not filename.lower().endswith(SLICED_SUFFIX):
        raise _refuse("not_sliced", status.HTTP_400_BAD_REQUEST)
    sliced_for = (library_file.file_metadata or {}).get("sliced_for_model")
    if not is_gcode_compatible(sliced_for, printer.model):
        raise _refuse("wrong_model", status.HTTP_400_BAD_REQUEST)

    lock = _lock()
    try:
        await asyncio.wait_for(lock.acquire(), LOCK_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        raise _refuse("queue_busy", status.HTTP_503_SERVICE_UNAVAILABLE) from exc
    try:
        reason = await blocker(db, printer)
        if reason is not None:
            raise _refuse(reason)

        created = await add_to_queue(
            PrintQueueItemCreate(
                printer_id=printer_id,
                library_file_id=library_file_id,
                # No queue pass picks it; this module starts it.
                manual_start=True,
                insert_at_top=True,
                bed_levelling="off",
                flow_cali="off",
                vibration_cali=False,
                layer_inspect=False,
                timelapse=False,
                nozzle_offset_cali="off",
                preheat_override="off",
                # The file is sent as it is: injecting the swap G-code into a
                # maintenance file that is itself a swap would swap twice.
                gcode_injection=False,
                skip_filament_check=True,
            ),
            db=db,
            current_user=current_user,
            printer_scope=printer_scope,
            review_required=review_required,
            actor=actor,
        )
        item_id = created.id
        await _map_filaments(db, printer_id, item_id)
        _launch(item_id, printer_id, clears_plate)
    finally:
        lock.release()

    logger.info(
        "hyyz17200 maintenance: queue item %s (%s) sent to printer %s, clears_plate=%s",
        item_id,
        filename,
        printer_id,
        clears_plate,
    )
    return item_id


async def _map_filaments(db: AsyncSession, printer_id: int, item_id: int) -> None:
    """The scheduler's own AMS match. Unmatched, the job goes out without one."""
    from backend.app.services.print_scheduler import scheduler

    try:
        item = await db.get(PrintQueueItem, item_id)
        if item is None or item.ams_mapping:
            return
        mapping = await scheduler._compute_ams_mapping_for_printer(db, printer_id, item)
        if mapping:
            item.ams_mapping = json.dumps(mapping)
            await db.commit()
    except Exception:
        logger.warning("hyyz17200 maintenance: no AMS mapping for queue item %s", item_id, exc_info=True)
        await db.rollback()


def _launch(item_id: int, printer_id: int, clears_plate: bool) -> None:
    """Start the dispatch the way a queue pass does. Synchronous, so the printer
    is in ``_inflight`` before the lock lets the next pass in."""
    from backend.app.services.print_scheduler import scheduler

    if clears_plate:
        plate_swap.mark_plate_clearing(item_id)
    task = spawn_background_task(_dispatch(item_id, printer_id), name=f"hyyz17200-maintenance-{item_id}")
    scheduler._inflight[item_id] = (task, printer_id)
    task.add_done_callback(lambda _t: scheduler._inflight.pop(item_id, None))


async def _dispatch(item_id: int, printer_id: int) -> None:
    from backend.app.services.print_scheduler import scheduler

    try:
        await scheduler._dispatch_one(item_id, printer_id)
    finally:
        plate_swap.unmark_plate_clearing(item_id)
        await _close_if_not_sent(item_id)


async def _close_if_not_sent(item_id: int) -> None:
    """A job still pending after its dispatch never started: fail it, so it
    does not wait at the top of the queue to print later."""
    try:
        async with async_session() as db:
            result = await db.execute(
                update(PrintQueueItem)
                .where(PrintQueueItem.id == item_id, PrintQueueItem.status == "pending")
                .values(
                    status="failed",
                    error_message=NOT_SENT_MESSAGE,
                    waiting_reason=None,
                    completed_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()
        if result.rowcount:
            logger.warning("hyyz17200 maintenance: queue item %s was not started; marked failed", item_id)
    except Exception:
        logger.exception("hyyz17200 maintenance: could not close queue item %s", item_id)
