"""Schema changes to the fork's own tables.

create_all only creates missing tables, so a new column on an existing one goes
here. Called from init_db() on every start and after every backup restore, so
each statement has to be safe to repeat: use core.database._safe_execute.
"""

from sqlalchemy.ext.asyncio import AsyncConnection


async def run_migrations(conn: AsyncConnection) -> None:
    pass
