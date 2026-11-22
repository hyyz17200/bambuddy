"""Plate count on upstream's plate changer count (#3575) (hyyz17200).

The fork's own counter is gone. What is left: its counts are moved to upstream's
printer columns once, and maintenance G-code keeps its two exceptions (it still
goes out with no plate left, and "uses a plate" unticked takes none off).
"""

import inspect
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.hyyz17200.models  # noqa: F401 - the fork's tables
from backend.app.core.database import Base
from backend.app.hyyz17200 import maintenance_jobs
from backend.app.hyyz17200.migrations import _move_plate_counts
from backend.app.hyyz17200.models import MaintenanceDispatch
from backend.app.models.printer import Printer
from backend.tests.integration.test_hyyz17200_maintenance_jobs import (
    _completion,
    _file,
    _folder,
    _maintenance_item,
    _set_folder,
    _set_status,
    _url,
    launched,  # noqa: F401
)
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401

# ---------------------------------------------------------------- migration

_OLD_TABLES = """
CREATE TABLE hyyz17200_plate_printer (
    printer_id INTEGER PRIMARY KEY, disabled BOOLEAN NOT NULL DEFAULT 0, capacity INTEGER,
    plates INTEGER, counting_since DATETIME, updated_at DATETIME, updated_by VARCHAR(100));
CREATE TABLE hyyz17200_plate_run (
    id INTEGER PRIMARY KEY, printer_id INTEGER, queue_item_id INTEGER, billing_run_id VARCHAR(36),
    kind VARCHAR(10), created_at DATETIME)
"""


@pytest.fixture
async def old_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for statement in _OLD_TABLES.split(";"):
            await conn.execute(text(statement))
    async with async_sessionmaker(engine)() as db:
        for pid in (1, 2, 3, 4, 5):
            db.add(Printer(id=pid, name=f"A1-{pid}", serial_number=f"S{pid}", ip_address="10.0.0.1", access_code="x"))
        await db.commit()
    yield engine
    await engine.dispose()


async def _seed(engine, *, enabled=True, default_capacity=10, rows=()):
    async with engine.begin() as conn:
        await conn.execute(
            text("INSERT INTO hyyz17200_setting (section, value) VALUES ('plate_count', :v)"),
            {"v": f'{{"enabled": {str(enabled).lower()}, "default_capacity": {default_capacity}}}'},
        )
        for pid, disabled, capacity, plates in rows:
            await conn.execute(
                text(
                    "INSERT INTO hyyz17200_plate_printer (printer_id, disabled, capacity, plates) VALUES (:p,:d,:c,:n)"
                ),
                {"p": pid, "d": disabled, "c": capacity, "n": plates},
            )
        await conn.execute(
            text("INSERT INTO hyyz17200_plate_run (printer_id, queue_item_id, kind) VALUES (1, 1, 'counted')")
        )


async def _upstream(engine) -> dict[int, tuple]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT id, plate_capacity, plates_remaining FROM printers ORDER BY id"))
        return {pid: (cap, rem) for pid, cap, rem in rows.all()}


async def _left(engine) -> tuple[int, int, int]:
    async with engine.connect() as conn:
        printers = (await conn.execute(text("SELECT COUNT(*) FROM hyyz17200_plate_printer"))).scalar()
        runs = (await conn.execute(text("SELECT COUNT(*) FROM hyyz17200_plate_run"))).scalar()
        section = (
            await conn.execute(text("SELECT COUNT(*) FROM hyyz17200_setting WHERE section = 'plate_count'"))
        ).scalar()
    return printers, runs, section


async def _migrate(engine) -> None:
    async with engine.begin() as conn:
        await _move_plate_counts(conn)


class TestMigration:
    @pytest.mark.asyncio
    async def test_counted_printers_move_to_upstream(self, old_db):
        await _seed(
            old_db,
            default_capacity=8,
            rows=[
                (1, False, None, 5),  # default capacity
                (2, False, 12, 0),  # own capacity, empty
                (3, True, None, None),  # switched off
                (4, False, None, None),  # not counted (plate-clear applies)
            ],
        )
        async with old_db.begin() as conn:
            await conn.execute(text("UPDATE printers SET plate_capacity = 3, plates_remaining = 1 WHERE id = 5"))
            await conn.execute(
                text("INSERT INTO hyyz17200_plate_printer (printer_id, disabled, capacity, plates) VALUES (5, 0, 9, 9)")
            )

        await _migrate(old_db)

        assert await _upstream(old_db) == {
            1: (8, 5),
            2: (12, 0),
            3: (None, None),
            4: (None, None),
            # Already set in Edit Printer: upstream's own value stays.
            5: (3, 1),
        }
        assert await _left(old_db) == (0, 0, 0)

    @pytest.mark.asyncio
    async def test_runs_once(self, old_db):
        await _seed(old_db, rows=[(1, False, None, 4)])
        await _migrate(old_db)
        # Cleared later in Edit Printer: a restart must not bring it back.
        async with old_db.begin() as conn:
            await conn.execute(text("UPDATE printers SET plate_capacity = NULL, plates_remaining = NULL"))

        await _migrate(old_db)

        assert (await _upstream(old_db))[1] == (None, None)

    @pytest.mark.asyncio
    async def test_nothing_moves_while_the_fork_feature_was_off(self, old_db):
        await _seed(old_db, enabled=False, rows=[(1, False, None, 4)])

        await _migrate(old_db)

        assert (await _upstream(old_db))[1] == (None, None)
        assert await _left(old_db) == (0, 0, 0)

    @pytest.mark.asyncio
    async def test_a_count_above_the_capacity_is_cut(self, old_db):
        await _seed(old_db, rows=[(1, False, 4, 7)])

        await _migrate(old_db)

        assert (await _upstream(old_db))[1] == (4, 4)

    @pytest.mark.asyncio
    async def test_a_database_without_the_old_tables(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            await _migrate(engine)
        finally:
            await engine.dispose()


# ---------------------------------------------------------------- maintenance G-code


async def _plate_changer(ctx, printer_id: int, capacity: int, remaining: int) -> None:
    async with ctx.session_maker() as db:
        await db.execute(
            update(Printer).where(Printer.id == printer_id).values(plate_capacity=capacity, plates_remaining=remaining)
        )
        await db.commit()


async def _maintenance_printing(ctx, *, uses_plate: bool) -> tuple[int, int]:
    printer_id = await ctx.add_printer("A1-01")
    item_id = await _maintenance_item(ctx, printer_id)
    async with ctx.session_maker() as db:
        await maintenance_jobs._record(db, item_id, uses_plate)
    await _set_status(ctx, item_id, "printing")
    return printer_id, item_id


async def _consume_through_wrappers(ctx, printer_id: int, data: dict) -> AsyncMock:
    """Upstream's completion path in miniature: close-out sets the context, and
    calls the (wrapped) plate count with the printer id only."""
    original = AsyncMock()
    consume = maintenance_jobs._wrap_consume(original)

    async def close_out(pid, _data):
        await consume(pid, job_clears_plate=False)

    with patch.object(maintenance_jobs, "async_session", ctx.session_maker):
        await maintenance_jobs._wrap_close_out(close_out)(printer_id, data)
    return original


class TestMaintenancePlates:
    @pytest.mark.asyncio
    async def test_unticked_takes_no_plate(self, farm):  # noqa: F811
        printer_id, _ = await _maintenance_printing(farm, uses_plate=False)

        with patch("backend.app.services.plate_changer.clear_count_pending") as cleared:
            original = await _consume_through_wrappers(farm, printer_id, _completion())

        original.assert_not_called()
        cleared.assert_called_once_with(printer_id)

    @pytest.mark.asyncio
    async def test_ticked_takes_one(self, farm):  # noqa: F811
        printer_id, _ = await _maintenance_printing(farm, uses_plate=True)

        original = await _consume_through_wrappers(farm, printer_id, _completion())

        original.assert_awaited_once_with(printer_id, job_clears_plate=False)

    @pytest.mark.asyncio
    async def test_another_file_finishing_takes_one(self, farm):  # noqa: F811
        printer_id, _ = await _maintenance_printing(farm, uses_plate=False)

        original = await _consume_through_wrappers(
            farm, printer_id, _completion(subtask_name="other", filename="/other.gcode.3mf")
        )

        original.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_an_ordinary_job_takes_one(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await _set_status(farm, item_id, "printing")

        original = await _consume_through_wrappers(farm, printer_id, _completion())

        original.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_without_a_completion_context_upstream_decides(self):
        original = AsyncMock()

        await maintenance_jobs._wrap_consume(original)(7)

        original.assert_awaited_once_with(7)

    @pytest.mark.asyncio
    async def test_the_send_records_the_choice(
        self,
        async_client: AsyncClient,
        db_session,
        printer_factory,
        launched,  # noqa: F811
    ):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        library_file = await _file(db_session, root.id)
        await _set_folder(db_session, root.id)

        with patch(
            "backend.app.services.print_scheduler.scheduler._compute_ams_mapping_for_printer",
            AsyncMock(return_value=None),
        ):
            response = await async_client.post(
                _url(printer.id), json={"library_file_id": library_file.id, "uses_plate": False}
            )

        assert response.status_code == 200, response.text
        dispatch = await db_session.get(MaintenanceDispatch, response.json()["queue_item_id"])
        assert dispatch.uses_plate is False


class TestEmptyPlateChanger:
    @pytest.mark.asyncio
    async def test_maintenance_g_code_still_goes_out(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        await _plate_changer(farm, printer_id, 10, 0)
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            scheduler._plate_changer_ids = {printer_id}
            with (
                patch("backend.app.services.print_scheduler.scheduler", scheduler),
                patch.object(maintenance_jobs, "async_session", farm.session_maker),
            ):
                maintenance_jobs.install()
                maintenance_jobs._launch(item_id, printer_id)
                await scheduler._inflight[item_id][0]

        assert (await farm.item(item_id)).status == "printing"

    @pytest.mark.asyncio
    async def test_a_queue_job_still_waits(self, farm):  # noqa: F811
        """Upstream's guard itself is untouched."""
        printer_id = await farm.add_printer("A1-01")
        await _plate_changer(farm, printer_id, 10, 0)
        item_id = await farm.add_item(printer_id=printer_id)

        async with _scheduler(farm) as scheduler:
            scheduler._plate_changer_ids = {printer_id}
            with patch("backend.app.services.print_scheduler.scheduler", scheduler):
                maintenance_jobs.install()
            await scheduler._dispatch_one(item_id, printer_id)

        assert (await farm.item(item_id)).status == "pending"

    @pytest.mark.asyncio
    async def test_not_while_the_last_print_is_closed_out(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        await _plate_changer(farm, printer_id, 10, 0)
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            scheduler._plate_changer_ids = {printer_id}
            with (
                patch("backend.app.services.print_scheduler.scheduler", scheduler),
                patch.object(maintenance_jobs, "async_session", farm.session_maker),
                patch("backend.app.services.plate_changer._count_pending", {printer_id}),
            ):
                maintenance_jobs.install()
                maintenance_jobs._launch(item_id, printer_id)
                await scheduler._inflight[item_id][0]

        assert (await farm.item(item_id)).status == "failed"


class TestUpstreamContracts:
    """What this patch borrows from upstream's #3575. A rename fails here, not on a printer."""

    def test_the_wrappers_are_installed(self):
        import backend.app.main as main
        from backend.app.services.print_scheduler import scheduler

        assert getattr(main.consume_auto_cleared_plate, "hyyz17200", False) is True
        assert getattr(main._close_out_print, "hyyz17200", False) is True
        assert getattr(scheduler._plate_changer_blocks_dispatch, "hyyz17200", False) is True

    def test_main_calls_them_by_name(self):
        import backend.app.main as main

        close_out = inspect.getsource(main._close_out_print.__wrapped__)
        assert "await consume_auto_cleared_plate(printer_id" in close_out
        assert "await _close_out_print(printer_id, data)" in inspect.getsource(main.on_print_complete)

    def test_the_dispatch_guard(self):
        from backend.app.services import plate_changer
        from backend.app.services.print_scheduler import PrintScheduler

        assert list(inspect.signature(PrintScheduler._plate_changer_blocks_dispatch).parameters) == [
            "self",
            "db",
            "printer_id",
        ]
        assert "self._plate_changer_blocks_dispatch(" in inspect.getsource(PrintScheduler._start_print)
        assert callable(plate_changer.is_count_pending)
        assert callable(plate_changer.clear_count_pending)
        assert isinstance(plate_changer._count_pending, set)

    def test_the_printer_api(self):
        """The frontend sets these through PATCH /printers/{id} and POST /printers/{id}/refill-plates."""
        from backend.app.api.routes import printers
        from backend.app.schemas.printer import PrinterResponse, PrinterUpdate

        assert {"plate_capacity", "plates_remaining", "plate_changer_show_count"} <= set(PrinterUpdate.model_fields)
        assert {"plate_capacity", "plates_remaining", "plate_changer_show_count"} <= set(PrinterResponse.model_fields)
        paths = {route.path for route in printers.router.routes}
        assert "/printers/{printer_id}/refill-plates" in paths


class TestUsesPlateColumn:
    @pytest.mark.asyncio
    async def test_added_to_an_existing_table_and_safe_to_repeat(self):
        from backend.app.hyyz17200.migrations import run_migrations

        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                await conn.execute(text("DROP TABLE hyyz17200_maintenance_dispatch"))
                await conn.execute(
                    text(
                        "CREATE TABLE hyyz17200_maintenance_dispatch (queue_item_id INTEGER PRIMARY KEY, sent_at DATETIME)"
                    )
                )
                await conn.execute(text("INSERT INTO hyyz17200_maintenance_dispatch (queue_item_id) VALUES (1)"))
            for _ in range(2):
                async with engine.begin() as conn:
                    await run_migrations(conn)
            async with engine.connect() as conn:
                value = (await conn.execute(text("SELECT uses_plate FROM hyyz17200_maintenance_dispatch"))).scalar()
            assert bool(value) is True
        finally:
            await engine.dispose()
