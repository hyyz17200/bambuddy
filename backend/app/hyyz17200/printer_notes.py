"""Notes on printers: standing descriptions, things to do, and what was done.

Upstream's maintenance log (``maintenance_log_entries``) only records the reset
of a maintenance task, with that task's name. These are free text and live in
their own table; the notes dialog shows upstream's resets alongside the "done"
notes, read from upstream's own API, so nothing is written to upstream's tables.

The printer card reads :func:`summaries` for every printer at once: a marker
shows while a printer has "info" or "todo" notes.
"""

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.hyyz17200.models.printer_note import NOTE_KINDS, PrinterNote
from backend.app.models.printer import Printer
from backend.app.utils.local_time import utcnow_naive

KINDS = NOTE_KINDS
BODY_MAX_LENGTH = 2000
# How much of a note the card's tooltip gets.
SNIPPET_LENGTH = 200
# The dialog's order: descriptions, then things to do, then history.
_KIND_ORDER = {kind: i for i, kind in enumerate(KINDS)}


async def summaries(db: AsyncSession, allows: Callable[[int], bool]) -> list[dict]:
    """Per printer with "info" or "todo" notes the caller may see: how many of
    each, and the newest "todo" (or, without one, the newest "info").

    Notes left behind by a deleted printer are skipped.
    """
    rows = await db.execute(
        select(PrinterNote.printer_id, PrinterNote.kind, PrinterNote.body)
        .join(Printer, Printer.id == PrinterNote.printer_id)
        .where(PrinterNote.kind.in_(("info", "todo")))
        .order_by(PrinterNote.printer_id, PrinterNote.created_at.desc(), PrinterNote.id.desc())
    )
    by_printer: dict[int, dict] = {}
    for printer_id, kind, body in rows.all():
        if not allows(printer_id):
            continue
        summary = by_printer.setdefault(
            printer_id, {"printer_id": printer_id, "todo_count": 0, "info_count": 0, "latest": ""}
        )
        summary[f"{kind}_count"] += 1
        # Newest first, so the first todo wins; an info only until one turns up.
        if (kind == "todo" and summary["todo_count"] == 1) or (not summary["latest"] and kind == "info"):
            summary["latest"] = body[:SNIPPET_LENGTH]
    return list(by_printer.values())


async def list_notes(db: AsyncSession, printer_id: int) -> list[PrinterNote]:
    """A printer's notes: info, then todo, then done; each newest first
    (done by when it was resolved)."""
    rows = await db.execute(select(PrinterNote).where(PrinterNote.printer_id == printer_id))
    notes = list(rows.scalars().all())
    notes.sort(key=lambda n: ((n.resolved_at if n.kind == "done" else None) or n.created_at, n.id), reverse=True)
    notes.sort(key=lambda n: _KIND_ORDER.get(n.kind, len(KINDS)))
    return notes


async def get_note(db: AsyncSession, printer_id: int, note_id: int) -> PrinterNote | None:
    note = await db.get(PrinterNote, note_id)
    return note if note is not None and note.printer_id == printer_id else None


def _set_kind(note: PrinterNote, kind: str, by: str | None) -> None:
    note.kind = kind
    if kind == "done":
        note.resolved_at = utcnow_naive()
        note.resolved_by = by
    else:
        note.resolved_at = None
        note.resolved_by = None


async def add_note(db: AsyncSession, printer_id: int, body: str, kind: str, by: str | None) -> PrinterNote:
    note = PrinterNote(printer_id=printer_id, body=body, created_at=utcnow_naive(), created_by=by)
    _set_kind(note, kind, by)
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


async def update_note(
    db: AsyncSession, note: PrinterNote, *, body: str | None, kind: str | None, by: str | None
) -> PrinterNote:
    """Change the text or the kind. Fields left as None stay as they are;
    sending what is already there changes nothing, not even the stamps."""
    if body is not None and body != note.body:
        note.body = body
        note.edited_at = utcnow_naive()
        note.edited_by = by
    if kind is not None and kind != note.kind:
        _set_kind(note, kind, by)
    await db.commit()
    await db.refresh(note)
    return note


async def delete_note(db: AsyncSession, note: PrinterNote) -> None:
    await db.delete(note)
    await db.commit()
