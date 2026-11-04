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


@pytest.mark.asyncio
@pytest.mark.parametrize("swapped", [True, False])
async def test_print_completion_asks_about_a_swapped_plate(swapped):
    """main.py raises the plate-clear gate only when the fork's check says no swap ran."""
    import asyncio
    from contextlib import ExitStack

    from backend.app.main import on_print_complete
    from backend.tests.integration.test_print_lifecycle import TestPlateClearGate

    data = {"status": "completed", "filename": "/data/Metadata/plate_1.gcode", "subtask_name": "Test"}
    tasks_before = set(asyncio.all_tasks())
    with ExitStack() as stack:
        mock_pm = TestPlateClearGate._setup_mocks(stack)
        check = stack.enter_context(
            patch("backend.app.main.hyyz17200_plate_swapped_away", AsyncMock(return_value=swapped))
        )
        await on_print_complete(1, data)
        for task in asyncio.all_tasks() - tasks_before:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    assert check.await_args.args[:2] == (1, data)
    raised = [c for c in mock_pm.set_awaiting_plate_clear.call_args_list if c.args == (1, True)]
    assert bool(raised) is not swapped


def test_the_fork_runs_inside_the_app_lifespan():
    """register() wraps upstream's lifespan, which resumes a batch calibration after a restart."""
    from backend.app.main import app

    assert getattr(app.router.lifespan_context, "hyyz17200", False) is True


@pytest.mark.asyncio
async def test_a_calibration_completion_reaches_the_plate_clear_hook():
    """A batch calibration skips the plate-clear check through the same hook, so
    upstream has to ask before it returns early for the printer's own jobs."""
    import asyncio
    from contextlib import ExitStack

    from backend.app.main import on_print_complete
    from backend.tests.integration.test_print_lifecycle import TestPlateClearGate

    data = {"status": "completed", "filename": "auto_cali_for_user_param", "subtask_name": "auto_cali_for_user_param"}
    tasks_before = set(asyncio.all_tasks())
    with ExitStack() as stack:
        mock_pm = TestPlateClearGate._setup_mocks(stack)
        check = stack.enter_context(
            patch("backend.app.main.hyyz17200_plate_swapped_away", AsyncMock(return_value=True))
        )
        await on_print_complete(1, data)
        for task in asyncio.all_tasks() - tasks_before:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    check.assert_awaited_once()
    assert not [c for c in mock_pm.set_awaiting_plate_clear.call_args_list if c.args == (1, True)]
