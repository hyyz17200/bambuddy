"""The fork's backend mount points stay connected (see .claude/rules/hyyz17200-fork.md)."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_the_fork_router_is_mounted(async_client: AsyncClient):
    response = await async_client.get("/api/v1/hyyz17200/info")

    assert response.status_code == 200
    assert response.json() == {"fork": "hyyz17200"}


@pytest.mark.asyncio
async def test_init_db_runs_the_fork_migrations(async_client: AsyncClient):
    from backend.app.core import database

    with patch("backend.app.hyyz17200.migrations.run_migrations", new_callable=AsyncMock) as run:
        await database.init_db()

    run.assert_awaited_once()
