from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, delete, event, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.printer import Printer


class PrinterLastTray(Base):
    """The AMS slot a printer last had loaded (slot preference).

    Upstream keeps it in memory only (``PrinterState.last_loaded_tray``), so it
    is gone after a restart. This copy is what the slot preference falls back
    on when a printer has nothing loaded and has not loaded anything since.
    """

    __tablename__ = "hyyz17200_printer_last_tray"

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    # Global tray id, as in an AMS mapping.
    tray: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


@event.listens_for(Printer, "after_delete")
def _forget_deleted_printer(_mapper, connection, target: Printer) -> None:
    """Drop the row with its printer. SQLite does not enforce the foreign key,
    and it hands a deleted printer's id to the next printer added."""
    connection.execute(delete(PrinterLastTray).where(PrinterLastTray.printer_id == target.id))
