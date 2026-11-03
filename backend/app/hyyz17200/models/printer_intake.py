from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, delete, event, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.printer import Printer


class PrinterIntakeStop(Base):
    """A printer the queue sends no new jobs to ("stop taking jobs").

    One row per printer while the stop is on. Unlike maintenance mode the
    printer stays connected: a running print finishes and is recorded, and every
    control on the card still works. Only queue dispatch skips it.
    """

    __tablename__ = "hyyz17200_printer_intake_stop"

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    stopped_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Who turned it on, for the card's tooltip. A name, not a user id: users
    # come and go, and this is only ever shown.
    stopped_by: Mapped[str | None] = mapped_column(String(100), nullable=True)


@event.listens_for(Printer, "after_delete")
def _forget_deleted_printer(_mapper, connection, target: Printer) -> None:
    """Drop the row with its printer. SQLite does not enforce the foreign key,
    and it hands a deleted printer's id to the next printer added, which would
    otherwise start out not taking jobs."""
    connection.execute(delete(PrinterIntakeStop).where(PrinterIntakeStop.printer_id == target.id))
