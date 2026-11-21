from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, delete, event, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.printer import Printer

# What a note is (printer_notes.KINDS):
#   info - a standing description of the printer ("0.6 nozzle fitted")
#   todo - something to look at; resolving it makes it "done"
#   done - resolved, or logged as already done: the printer's history
NOTE_KINDS = ("info", "todo", "done")


class PrinterNote(Base):
    """One note on a printer.

    Upstream's maintenance log only records the reset of a maintenance task;
    this is free text. The printer card shows a marker while a printer has
    "info" or "todo" notes. Names, not user ids: users come and go, and these
    are only shown.
    """

    __tablename__ = "hyyz17200_printer_note"
    __table_args__ = (Index("ix_hyyz17200_printer_note_printer_kind", "printer_id", "kind"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(10), default="info")
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Set when the text is edited, not when the kind changes.
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    edited_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Set while the note is "done"; cleared when it becomes anything else.
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(100), nullable=True)


@event.listens_for(Printer, "after_delete")
def _forget_deleted_printer(_mapper, connection, target: Printer) -> None:
    """Drop the notes with their printer. SQLite does not enforce the foreign
    key, and it hands a deleted printer's id to the next printer added, which
    would otherwise start out with the old printer's notes."""
    connection.execute(delete(PrinterNote).where(PrinterNote.printer_id == target.id))
