"""Prints that swapped their own plate away skip the plate-clear check.

A farm can mix printers with a plate swapper (End G-code injected by the queue
ejects the plate) and printers without one. Upstream's plate-clear check is a
single global switch, so it either holds every printer after each print or
none. This keeps it on for everyone, and lets a print through only when the
swap really ran.

The check (:func:`plate_swapped_away`) passes only when all of these hold:

- the print completed: a failed, aborted or cancelled one never reaches the
  End G-code;
- the printer has exactly one queue job printing, and the scheduler recorded
  that job as sent with End G-code injected (:func:`record_dispatch`);
- the completion names that job's file. Upstream's own matching lets an
  unknown name through so the queue does not wedge; here an unknown name holds
  the printer instead.

Anything else, including any error, leaves upstream's check in place, so every
doubt costs one "plate cleared" click rather than a print on a full plate.

The record lives in ``hyyz17200_plate_swap_dispatch`` rather than upstream's
in-memory ``print_dispatch_context``, so restarting Bambuddy mid-print does not
make a farm of swappers wait for a click each.

The same hook also lets a completed batch calibration through
(calibration_batch.skips_plate_clear): it prints nothing.
"""

import logging
from collections.abc import Callable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.hyyz17200 import calibration_batch
from backend.app.hyyz17200.models.plate_swap import PlateSwapDispatch
from backend.app.models.print_queue import PrintQueueItem

logger = logging.getLogger(__name__)

# Jobs whose rows may still be read. Rows of every other job are pruned.
_OPEN_STATUSES = ("pending", "printing")


async def record_dispatch(db: AsyncSession, queue_item_id: int, end_gcode_injected: bool) -> None:
    """Record whether the job being sent has End G-code in it.

    Called for every job the scheduler sends, after the injection step, so a
    retried send that lost its injection also loses its row. Does not commit:
    the row goes in with the dispatch's own next commit. Never raises; a
    failure leaves no row, which keeps the plate-clear check on.
    """
    try:
        async with db.begin_nested():
            open_jobs = select(PrintQueueItem.id).where(PrintQueueItem.status.in_(_OPEN_STATUSES))
            await db.execute(
                delete(PlateSwapDispatch).where(
                    (PlateSwapDispatch.queue_item_id == queue_item_id)
                    | PlateSwapDispatch.queue_item_id.not_in(open_jobs)
                )
            )
            if end_gcode_injected:
                db.add(PlateSwapDispatch(queue_item_id=queue_item_id))
    except Exception:
        logger.warning("hyyz17200: could not record End G-code for queue item %s", queue_item_id, exc_info=True)


async def plate_swapped_away(printer_id: int, data: dict, session_factory: Callable) -> bool:
    """Whether this completed print ejected its own plate, so no click is needed.

    ``session_factory`` is main.py's ``async_session``, passed in so tests that
    patch it there also cover this. Never raises; an error means "not swapped".
    """
    if data.get("status") != "completed":
        return False
    try:
        async with session_factory() as db:
            # Also the one place a batch calibration's completion can skip the
            # check: it leaves nothing on the bed either. Here rather than in
            # main.py so that file keeps a single hook.
            if await calibration_batch.skips_plate_clear(db, printer_id, data):
                logger.info("hyyz17200: printer %s finished a batch calibration, no plate-clear check", printer_id)
                return True
            swapped = await _swapped(db, printer_id, data)
    except Exception:
        logger.warning("hyyz17200: plate-swap check failed for printer %s", printer_id, exc_info=True)
        return False
    if swapped:
        logger.info("hyyz17200: printer %s swapped its plate, no plate-clear check needed", printer_id)
    return swapped


async def _swapped(db: AsyncSession, printer_id: int, data: dict) -> bool:
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
        return False
    item = printing[0]
    if await db.get(PlateSwapDispatch, item.id) is None:
        return False

    expected = await _queue_item_dispatched_name(db, item)
    if not expected:
        return False
    # The printer echoes the subtask name; a completion synthesised at reconnect
    # carries the archive's file name, and may carry a different print name.
    observed = [
        data.get("subtask_name") or "",
        _subtask_name_from_filename((data.get("filename") or "").rsplit("/", 1)[-1]),
    ]
    return any(name and _subtask_names_match(expected, name) for name in observed)
