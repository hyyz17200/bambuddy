from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, delete, event, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.printer import Printer


class PlatePrinter(Base):
    """A printer's plate count (plate_count.py): its own settings, and how many
    clean plates it holds while it is being counted.

    One row per printer that has ever had either. ``plates`` is None while the
    printer is not counted (the feature off, the plate-clear confirmation applies
    to it, or it is switched off here); counting starts again from a full stack.
    """

    __tablename__ = "hyyz17200_plate_printer"

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    # Switched off on this printer (only printers that swap their own plates are counted at all).
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # Plates a full stack holds, the bed's included. None uses the Enhanced Settings default.
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Clean plates left, the one on the bed included. None while not counted.
    plates: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # When counting started (naive UTC): jobs started before it are not counted.
    counting_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # The last time someone set the count, and who. Shown, never used.
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(100), nullable=True)


class PlateRun(Base):
    """A queue job's run that plate_count.py has dealt with, by upstream's
    ``billing_run_id`` (new on every dispatch, so a job sent again is a new run).

    ``counted``: it finished and took one plate off the count. ``exempt``: a
    maintenance G-code job sent with "uses a plate" unticked; written with no run
    id when the job is created, and given the run id once it is seen running.
    Pruned after plate_count.RUN_RETENTION.
    """

    __tablename__ = "hyyz17200_plate_run"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    # Not a foreign key: the queue job may be deleted, and this row must outlive it.
    queue_item_id: Mapped[int] = mapped_column(Integer, index=True)
    billing_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


@event.listens_for(Printer, "after_delete")
def _forget_deleted_printer(_mapper, connection, target: Printer) -> None:
    """SQLite does not enforce the foreign keys and reuses a deleted printer's id,
    which would hand the next printer this one's count."""
    connection.execute(delete(PlatePrinter).where(PlatePrinter.printer_id == target.id))
    connection.execute(delete(PlateRun).where(PlateRun.printer_id == target.id))
