from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, delete, event, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.printer import Printer


class CalibrationBatch(Base):
    """A batch calibration: printers calibrated one after another (calibration_batch.py).

    At most one batch is ``running`` at a time. A finished or cancelled batch is
    kept so its results can still be read; starting a new batch deletes them.
    """

    __tablename__ = "hyyz17200_calibration_batch"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # running | finished | cancelled
    status: Mapped[str] = mapped_column(String(20), default="running")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # What was asked for. Motor noise is only sent to printers that report it.
    bed_leveling: Mapped[bool] = mapped_column(Boolean, default=True)
    vibration: Mapped[bool] = mapped_column(Boolean, default=True)
    motor_noise: Mapped[bool] = mapped_column(Boolean, default=True)
    # Resume taking jobs on each printer whose calibration succeeded.
    resume_intake: Mapped[bool] = mapped_column(Boolean, default=True)


class CalibrationItem(Base):
    """One printer in a batch."""

    __tablename__ = "hyyz17200_calibration_item"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("hyyz17200_calibration_batch.id", ondelete="CASCADE"), index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    # waiting | starting | running | succeeded | failed | skipped | cancelled
    status: Mapped[str] = mapped_column(String(20), default="waiting")
    # Why it failed, was skipped or was cancelled (a code the page translates).
    detail: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # The printer was not taking jobs before the batch, so success leaves it so.
    intake_was_stopped: Mapped[bool] = mapped_column(Boolean, default=False)
    # The option bitmask actually sent, and whether motor noise was asked for
    # but left out because the printer does not report it.
    option: Mapped[int | None] = mapped_column(Integer, nullable=True)
    motor_noise_skipped: Mapped[bool] = mapped_column(Boolean, default=False)
    # The printer reported its job as the calibration at least once.
    recognized: Mapped[bool] = mapped_column(Boolean, default=False)
    # Stage numbers seen while running, comma separated, for the log and the page.
    stages: Mapped[str] = mapped_column(String(400), default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    running_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


@event.listens_for(Printer, "after_delete")
def _forget_deleted_printer(_mapper, connection, target: Printer) -> None:
    """Drop the printer's rows with it. SQLite does not enforce the foreign key
    and hands a deleted printer's id to the next printer added."""
    connection.execute(delete(CalibrationItem).where(CalibrationItem.printer_id == target.id))
