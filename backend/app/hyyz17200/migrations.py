"""Schema changes to the fork's own tables, and what has to follow them.

create_all only creates missing tables, so a new column on an existing one goes
here. Called from init_db() on every start and after every backup restore, so
each statement has to be safe to repeat: use core.database._safe_execute.
"""

from sqlalchemy.ext.asyncio import AsyncConnection

from backend.app.hyyz17200.hms_filter import load_hidden_codes


async def run_migrations(conn: AsyncConnection) -> None:
    await load_hidden_codes(conn)
