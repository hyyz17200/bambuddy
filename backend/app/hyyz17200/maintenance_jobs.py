"""Maintenance G-code: send one sliced file to one printer, now.

The card menu's "Send maintenance G-code" lists the sliced files under a library
folder chosen in Enhanced Settings (subfolders included) and sends the one
picked. It goes out at once, whether or not the printer is taking jobs and
whatever else is waiting in the queue.

It is still an ordinary queue job, so the archive, statistics and every check
upstream's ``_start_print`` makes (nozzle size, the busy guard, the upload, the
watchdog) stay upstream's. What it skips is the queue
pass that would pick it: the job is created with ``manual_start`` so no pass
ever picks it, and this module hands it straight to the scheduler's dispatch
worker (``_dispatch_one``), registered in ``_inflight`` the way a pass would.
That pass is where the "stop taking jobs" hold lives, along with the queue
order, the 30 s tick and the filament checks, none of which apply here.

Two things a pass would do are done here instead:

- the readiness check: connected, idle, no queue job on its way, not unloading,
  not drying, no Home Assistant interlock, and not waiting for its plate to be
  cleared (where upstream's plate-clear confirmation applies to it). A printer
  that is not ready refuses the send rather than holding it, because a held
  maintenance job would go out whenever the printer next came free;
- the AMS mapping, computed by the scheduler's own function. When nothing
  matches the job goes out without one.

A send and a queue pass never run at the same time (:func:`install` wraps
``check_queue`` in the same lock). Otherwise a pass that had already counted
the printer as free could send it a queue job while this upload runs.

A job that was not started is closed as failed, not left pending: it sits at
the top of the queue, and a pending job there would print the next time
anything started it.

A maintenance job stays out of the plate-clear flag: it is only sent to a
plate that is clear (or to a printer the confirmation does not apply to), and
its completion does not raise the flag (:func:`skips_plate_clear`, asked by
main.py's hook in plate_clear_hook.py). A failed or cancelled one does.

``stop_intake`` (on by default in the dialog) stops the printer taking queue
jobs once the job is on its way, so nothing follows it before someone looks.

Upstream's plate changer count (#3575) is kept, with two exceptions for these
jobs (both wrappers in :func:`install`):

- an empty plate changer still takes maintenance G-code (a swap file is how a
  plate gets back onto the bed remotely): upstream's ``_plate_changer_blocks_dispatch``
  answers "go" for the maintenance job being dispatched, unless the printer's
  last print is still being closed out;
- ``uses_plate`` (on by default) is whether the job's completion takes a plate
  off. Unticked, upstream's ``consume_auto_cleared_plate`` is skipped for it.

Nothing about the file's G-code is checked: what it does is the user's choice.
"""

import asyncio
import json
import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200 import calibration_batch, printer_intake
from backend.app.hyyz17200.models.maintenance_job import MaintenanceDispatch
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
# Jobs whose rows may still be read. Rows of every other job are pruned.
_OPEN_STATUSES = ("pending", "printing")


class MaintenanceSettings(BaseModel):
    # The library folder whose sliced files (subfolders included) are offered.
    folder_id: int | None = None


_locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}

# The printer whose maintenance job this task is dispatching (set in _dispatch).
_dispatching: ContextVar[int | None] = ContextVar("hyyz17200_maintenance_dispatching", default=None)
# The completion main._close_out_print is handling (set by its wrapper), for the
# plate count wrapper, which upstream calls with the printer id only.
_completion: ContextVar[tuple[int, dict] | None] = ContextVar("hyyz17200_maintenance_completion", default=None)


def _lock() -> asyncio.Lock:
    """One lock per event loop: tests run several, and a lock belongs to one."""
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = _locks[loop] = asyncio.Lock()
    return lock


def install() -> None:
    """Run every queue pass under the send lock, and fit upstream's plate changer
    count (#3575) to maintenance jobs. Idempotent."""
    from backend.app.services.print_scheduler import scheduler

    current = scheduler.check_queue
    if getattr(current, "hyyz17200", False) is not True:

        async def check_queue() -> bool:
            async with _lock():
                return await current()

        check_queue.hyyz17200 = True
        scheduler.check_queue = check_queue

    blocks = scheduler._plate_changer_blocks_dispatch
    if getattr(blocks, "hyyz17200", False) is not True:

        async def plate_changer_blocks_dispatch(db: AsyncSession, printer_id: int) -> bool:
            if _dispatching.get() == printer_id:
                from backend.app.services.plate_changer import is_count_pending

                # Out of plates is no reason to hold maintenance G-code; a print
                # still being closed out is: the queue waits for it as well.
                return is_count_pending(printer_id)
            return await blocks(db, printer_id)

        plate_changer_blocks_dispatch.hyyz17200 = True
        plate_changer_blocks_dispatch.__wrapped__ = blocks
        scheduler._plate_changer_blocks_dispatch = plate_changer_blocks_dispatch

    main = sys.modules.get("backend.app.main")
    if main is None:
        import backend.app.main as main
    if getattr(main._close_out_print, "hyyz17200", False) is not True:
        main._close_out_print = _wrap_close_out(main._close_out_print)
    if getattr(main.consume_auto_cleared_plate, "hyyz17200", False) is not True:
        main.consume_auto_cleared_plate = _wrap_consume(main.consume_auto_cleared_plate)


def _wrap_close_out(original):
    async def close_out_print(printer_id: int, data: dict):
        token = _completion.set((printer_id, data))
        try:
            return await original(printer_id, data)
        finally:
            _completion.reset(token)

    close_out_print.hyyz17200 = True
    close_out_print.__wrapped__ = original
    return close_out_print


def _wrap_consume(original):
    async def consume_auto_cleared_plate(printer_id: int, *args, **kwargs):
        completion = _completion.get()
        if completion is not None and completion[0] == printer_id:
            try:
                async with async_session() as db:
                    dispatch = await _finishing_dispatch(db, printer_id, completion[1])
                    skip = dispatch is not None and not dispatch.uses_plate
            except Exception:
                logger.warning("hyyz17200 maintenance: plate check failed for printer %s", printer_id, exc_info=True)
                skip = False
            if skip:
                from backend.app.services.plate_changer import clear_count_pending

                clear_count_pending(printer_id)
                logger.info(
                    "hyyz17200 maintenance: printer %s finished maintenance G-code sent as not using a plate; "
                    "plate count left as it was",
                    printer_id,
                )
                return None
        return await original(printer_id, *args, **kwargs)

    consume_auto_cleared_plate.hyyz17200 = True
    consume_auto_cleared_plate.__wrapped__ = original
    return consume_auto_cleared_plate


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

    The batch calibration's check, ``plate_clear`` included, plus drying and
    the Home Assistant interlocks.
    """
    reason = calibration_batch._blocker(printer, await calibration_batch.plate_clear_setting(db))
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
    stop_intake: bool,
    *,
    uses_plate: bool = True,
    current_user: Any,
    printer_scope: Any,
    review_required: bool,
    actor: Any,
) -> tuple[int, bool]:
    """Create the job through upstream's queue route and start its dispatch.

    Returns the queue item id once the upload is under way, and whether the
    printer stopped taking jobs as asked. Raises an HTTPException whose
    ``detail`` is a short code when the send is refused.
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
        await _record(db, item_id, uses_plate)
        _launch(item_id, printer_id)
        intake_stopped = stop_intake and await _stop_intake(db, printer_id, getattr(current_user, "username", None))
    finally:
        lock.release()

    logger.info(
        "hyyz17200 maintenance: queue item %s (%s) sent to printer %s, stop taking jobs=%s",
        item_id,
        filename,
        printer_id,
        intake_stopped,
    )
    return item_id, intake_stopped


async def _record(db: AsyncSession, item_id: int, uses_plate: bool = True) -> None:
    """Mark the job as maintenance, so its completion leaves the plate-clear flag
    alone (and the plate count, without ``uses_plate``). A failure only logs: the
    completion then raises the flag and takes a plate off as usual."""
    try:
        open_jobs = select(PrintQueueItem.id).where(PrintQueueItem.status.in_(_OPEN_STATUSES))
        await db.execute(
            delete(MaintenanceDispatch).where(
                (MaintenanceDispatch.queue_item_id == item_id) | MaintenanceDispatch.queue_item_id.not_in(open_jobs)
            )
        )
        db.add(MaintenanceDispatch(queue_item_id=item_id, uses_plate=uses_plate))
        await db.commit()
    except Exception:
        logger.warning("hyyz17200 maintenance: could not mark queue item %s", item_id, exc_info=True)
        await db.rollback()


async def _stop_intake(db: AsyncSession, printer_id: int, by: str | None) -> bool:
    """The job is already on its way, so a failure here only logs."""
    try:
        await printer_intake.set_stopped(db, printer_id, True, by)
        return True
    except Exception:
        logger.warning("hyyz17200 maintenance: printer %s could not stop taking jobs", printer_id, exc_info=True)
        await db.rollback()
        return False


async def skips_plate_clear(db: AsyncSession, printer_id: int, data: dict) -> bool:
    """This completion is a maintenance job's, so the plate-clear flag stays as
    it was. Called by plate_clear_hook.skips_plate_clear for a completed print."""
    return await _finishing_dispatch(db, printer_id, data) is not None


async def _finishing_dispatch(db: AsyncSession, printer_id: int, data: dict) -> MaintenanceDispatch | None:
    """The maintenance job this completion belongs to, or None.

    The printer must have exactly one queue job printing, sent as maintenance,
    and the completion must name its file. Upstream's own matching lets an
    unknown name through so the queue does not wedge; here it counts as not
    maintenance (the plate-clear flag goes up, a plate is taken off).
    """
    # Deferred: main imports this package, and these helpers live in main.
    from backend.app.main import _queue_item_dispatched_name, _subtask_name_from_filename, _subtask_names_match

    printing = (
        (
            await db.execute(
                select(PrintQueueItem).where(
                    PrintQueueItem.printer_id == printer_id, PrintQueueItem.status == "printing"
                )
            )
        )
        .scalars()
        .all()
    )
    if len(printing) != 1:
        return None
    item = printing[0]
    dispatch = await db.get(MaintenanceDispatch, item.id)
    if dispatch is None:
        return None
    expected = await _queue_item_dispatched_name(db, item)
    if not expected:
        return None
    # The printer echoes the subtask name; a completion synthesised at reconnect
    # carries the archive's file name, and may carry a different print name.
    observed = [
        data.get("subtask_name") or "",
        _subtask_name_from_filename((data.get("filename") or "").rsplit("/", 1)[-1]),
    ]
    return dispatch if any(name and _subtask_names_match(expected, name) for name in observed) else None


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


def _launch(item_id: int, printer_id: int) -> None:
    """Start the dispatch the way a queue pass does. Synchronous, so the printer
    is in ``_inflight`` before the lock lets the next pass in."""
    from backend.app.services.print_scheduler import scheduler

    task = spawn_background_task(_dispatch(item_id, printer_id), name=f"hyyz17200-maintenance-{item_id}")
    scheduler._inflight[item_id] = (task, printer_id)
    task.add_done_callback(lambda _t: scheduler._inflight.pop(item_id, None))


async def _dispatch(item_id: int, printer_id: int) -> None:
    from backend.app.services.print_scheduler import scheduler

    # This task's own context: upstream's plate changer guard lets it through.
    _dispatching.set(printer_id)
    try:
        await scheduler._dispatch_one(item_id, printer_id)
    finally:
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
