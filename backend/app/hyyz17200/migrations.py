"""Schema changes to the fork's own tables, and what has to follow them.

create_all only creates missing tables, so a new column on an existing one goes
here. Called from init_db() on every start and after every backup restore, so
each statement has to be safe to repeat: use core.database._safe_execute.
"""

import json
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from backend.app.hyyz17200.hms_filter import load_hidden_codes

logger = logging.getLogger(__name__)

# The fork's own plate count, replaced by upstream's plate changer count (#3575).
# Its tables are left in the database (a downgrade still finds them); their rows
# are moved once, see _move_plate_counts.
_OLD_PLATE_TABLES = ("hyyz17200_plate_printer", "hyyz17200_plate_run")
_OLD_PLATE_SECTION = "plate_count"
_OLD_DEFAULT_CAPACITY = 10


async def run_migrations(conn: AsyncConnection) -> None:
    from backend.app.core.database import _safe_execute

    await _safe_execute(
        conn, "ALTER TABLE hyyz17200_maintenance_dispatch ADD COLUMN uses_plate BOOLEAN NOT NULL DEFAULT TRUE"
    )
    await _move_plate_counts(conn)
    await load_hidden_codes(conn)


async def _table_exists(conn: AsyncConnection, name: str) -> bool:
    def check(sync_conn) -> bool:
        from sqlalchemy import inspect

        return inspect(sync_conn).has_table(name)

    return await conn.run_sync(check)


async def _move_plate_counts(conn: AsyncConnection) -> None:
    """Carry the fork's plate counts over to upstream's printer columns, once.

    Only printers it was counting (the feature on, the printer not switched off,
    a count present) and that have no upstream capacity yet. The fork's rows and
    its settings section are deleted afterwards, so this runs once and a capacity
    cleared later in Edit Printer stays cleared.
    """
    if not await _table_exists(conn, _OLD_PLATE_TABLES[0]):
        return
    rows = (
        await conn.execute(
            text(f"SELECT printer_id, disabled, capacity, plates FROM {_OLD_PLATE_TABLES[0]}")  # nosec B608
        )
    ).all()
    raw = (
        await conn.execute(text("SELECT value FROM hyyz17200_setting WHERE section = :s"), {"s": _OLD_PLATE_SECTION})
    ).scalar_one_or_none()
    if not rows and raw is None:
        return
    try:
        settings = json.loads(raw) if raw else {}
    except ValueError:
        settings = {}
    enabled = settings.get("enabled") is True
    default_capacity = settings.get("default_capacity")
    if not isinstance(default_capacity, int) or not 1 <= default_capacity <= 999:
        default_capacity = _OLD_DEFAULT_CAPACITY

    moved = 0
    async with conn.begin_nested():
        if enabled:
            for printer_id, disabled, capacity, plates in rows:
                if disabled or plates is None:
                    continue
                capacity = capacity or default_capacity
                result = await conn.execute(
                    text(
                        "UPDATE printers SET plate_capacity = :capacity, plates_remaining = :plates "
                        "WHERE id = :id AND plate_capacity IS NULL"
                    ),
                    {"capacity": capacity, "plates": max(0, min(plates, capacity)), "id": printer_id},
                )
                moved += result.rowcount or 0
        for table in _OLD_PLATE_TABLES:
            if await _table_exists(conn, table):
                await conn.execute(text(f"DELETE FROM {table}"))  # nosec B608
        await conn.execute(text("DELETE FROM hyyz17200_setting WHERE section = :s"), {"s": _OLD_PLATE_SECTION})
    if moved:
        logger.info("hyyz17200: moved the plate count of %s printers to upstream's plate changer count", moved)
