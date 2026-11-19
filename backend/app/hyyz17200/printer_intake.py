"""Printers that stopped taking queue jobs (the card menu's "Stop taking jobs").

Maintenance mode (upstream ``Printer.is_active``) disconnects the printer. This
leaves it connected and only keeps the queue from sending it anything new: the
running print finishes and is recorded, the controls still work, and the
printer keeps its location, so jobs aimed at that location stay aimed at it.

The scheduler reads :func:`queue_skipped_printer_ids` once per queue pass and
treats those printers as taken: a job pinned to one waits, a job for "any
<model>" goes to another printer, and the smart-plug wake step leaves them off.
Besides the printers not taking jobs, that includes the ones auto_unload.py is
unloading for the few minutes it takes, which the printer still reports idle,
and the ones a batch calibration is waiting to calibrate or calibrating. Those
two are in memory and never change the printer's own "stop taking jobs".
"""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.hyyz17200 import auto_unload, calibration_batch
from backend.app.hyyz17200.models.printer_intake import PrinterIntakeStop
from backend.app.models.printer import Printer

# Appended to the printer's name in a pinned job's waiting reason. It starts
# with "Busy:" on purpose: the queue reads that as nothing for the user to do,
# so no "job waiting" notification goes out for a stop the user turned on.
WAITING_SUFFIX = "(not taking jobs)"
UNLOADING_SUFFIX = "(unloading filament)"
CALIBRATING_SUFFIX = "(batch calibration)"


async def stopped_printer_ids(db: AsyncSession) -> set[int]:
    """Printers not taking jobs. Rows left behind by a deleted printer are skipped."""
    rows = await db.execute(
        select(PrinterIntakeStop.printer_id).join(Printer, Printer.id == PrinterIntakeStop.printer_id)
    )
    return {printer_id for (printer_id,) in rows.all()}


async def queue_skipped_printer_ids(db: AsyncSession) -> set[int]:
    """What the queue leaves alone this pass: printers not taking jobs, printers
    being unloaded, and printers in a running batch calibration."""
    return await stopped_printer_ids(db) | auto_unload.busy_printer_ids() | calibration_batch.held_printer_ids()


async def list_stops(db: AsyncSession) -> list[PrinterIntakeStop]:
    rows = await db.execute(
        select(PrinterIntakeStop)
        .join(Printer, Printer.id == PrinterIntakeStop.printer_id)
        .order_by(PrinterIntakeStop.printer_id)
    )
    return list(rows.scalars().all())


async def set_stopped(db: AsyncSession, printer_id: int, stopped: bool, by: str | None) -> None:
    """Turn the stop on or off. Repeating either is a no-op; turning it on again
    keeps the original time and name."""
    row = await db.get(PrinterIntakeStop, printer_id)
    if stopped and row is None:
        db.add(PrinterIntakeStop(printer_id=printer_id, stopped_by=by))
    elif not stopped and row is not None:
        await db.execute(delete(PrinterIntakeStop).where(PrinterIntakeStop.printer_id == printer_id))
    await db.commit()


def waiting_reason(printer_label: str, printer_id: int | None = None) -> str:
    """A pinned job's waiting reason for a printer from queue_skipped_printer_ids."""
    if printer_id is not None and auto_unload.is_busy(printer_id):
        return f"Busy: {printer_label} {UNLOADING_SUFFIX}"
    if printer_id is not None and calibration_batch.is_held(printer_id):
        return f"Busy: {printer_label} {CALIBRATING_SUFFIX}"
    return f"Busy: {printer_label} {WAITING_SUFFIX}"
