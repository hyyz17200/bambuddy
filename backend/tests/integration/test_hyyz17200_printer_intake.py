"""Stop taking jobs: the queue skips the printer, nothing else changes (hyyz17200)."""

import asyncio
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
import backend.app.services.archive as archive_module
import backend.app.services.print_scheduler as scheduler_module
from backend.app.core.database import Base
from backend.app.hyyz17200 import printer_intake
from backend.app.hyyz17200.models import PrinterIntakeStop
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler

LIST_URL = "/api/v1/hyyz17200/printers/intake-stops"


def _intake_url(printer_id: int) -> str:
    return f"/api/v1/hyyz17200/printers/{printer_id}/intake"


class TestApi:
    @pytest.mark.asyncio
    async def test_stop_and_resume(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="A1-01")

        assert (await async_client.get(LIST_URL)).json() == []

        response = await async_client.put(_intake_url(printer.id), json={"stopped": True})
        assert response.status_code == 200
        assert response.json() == {"stopped": True}
        stops = (await async_client.get(LIST_URL)).json()
        assert [stop["printer_id"] for stop in stops] == [printer.id]
        assert stops[0]["stopped_at"] is not None

        # Repeating either direction is harmless.
        assert (await async_client.put(_intake_url(printer.id), json={"stopped": True})).status_code == 200
        assert len((await async_client.get(LIST_URL)).json()) == 1

        assert (await async_client.put(_intake_url(printer.id), json={"stopped": False})).status_code == 200
        assert (await async_client.get(LIST_URL)).json() == []
        assert (await async_client.put(_intake_url(printer.id), json={"stopped": False})).status_code == 200

    @pytest.mark.asyncio
    async def test_null_is_refused_not_ignored(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        for body in ({"stopped": None}, {}):
            assert (await async_client.put(_intake_url(printer.id), json=body)).status_code == 422
        assert (await async_client.get(LIST_URL)).json() == []

    @pytest.mark.asyncio
    async def test_unknown_printer(self, async_client: AsyncClient):
        response = await async_client.put(_intake_url(9999), json={"stopped": True})
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_the_printer_stays_active(self, async_client: AsyncClient, printer_factory, db_session):
        """Unlike maintenance mode, upstream's is_active is never touched."""
        printer = await printer_factory()
        await async_client.put(_intake_url(printer.id), json={"stopped": True})

        await db_session.refresh(printer)
        assert printer.is_active is True

    @pytest.mark.asyncio
    async def test_deleting_the_printer_drops_its_row(self, db_session, printer_factory):
        """SQLite reuses a deleted printer's id, so the row must not outlive it."""
        printer = await printer_factory()
        await printer_intake.set_stopped(db_session, printer.id, True, None)

        await db_session.delete(printer)
        await db_session.commit()

        assert (await db_session.execute(select(PrinterIntakeStop))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_a_left_behind_row_is_ignored(self, db_session, printer_factory):
        printer = await printer_factory()
        db_session.add(PrinterIntakeStop(printer_id=printer.id + 100))
        await db_session.commit()

        assert await printer_intake.stopped_printer_ids(db_session) == set()


# ---------------------------------------------------------------------------
# Scheduler. Same harness as test_scheduler_busy_reasons_3018: an in-memory
# database and every printer-facing call mocked out.


@pytest.fixture
async def farm(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    base_dir = tmp_path / "farm"
    (base_dir / "archives").mkdir(parents=True, exist_ok=True)

    async def add_printer(name: str) -> int:
        async with session_maker() as db:
            printer = Printer(
                name=name,
                serial_number=f"SERIAL-{name}",
                ip_address="10.0.0.1",
                access_code="access-code",
                model="X1C",
            )
            db.add(printer)
            await db.commit()
            return printer.id

    async def add_item(*, printer_id: int | None = None, target_model: str | None = None, position: int = 0) -> int:
        async with session_maker() as db:
            archive_rel = Path("archives") / f"job-{position}.3mf"
            (base_dir / archive_rel).write_bytes(b"archive payload")
            archive = PrintArchive(
                printer_id=printer_id,
                filename=f"job-{position}.3mf",
                file_path=str(archive_rel),
                file_size=15,
                print_time_seconds=120,
                status="completed",
            )
            db.add(archive)
            await db.flush()
            item = PrintQueueItem(
                printer_id=printer_id,
                target_model=target_model,
                archive_id=archive.id,
                status="pending",
                position=position,
            )
            db.add(item)
            await db.commit()
            return item.id

    async def set_stopped(printer_id: int, stopped: bool) -> None:
        async with session_maker() as db:
            await printer_intake.set_stopped(db, printer_id, stopped, None)

    async def item(item_id: int) -> PrintQueueItem:
        async with session_maker() as db:
            return await db.get(PrintQueueItem, item_id)

    try:
        yield SimpleNamespace(
            session_maker=session_maker,
            base_dir=base_dir,
            add_printer=add_printer,
            add_item=add_item,
            set_stopped=set_stopped,
            item=item,
        )
    finally:
        await engine.dispose()


@asynccontextmanager
async def _scheduler(ctx):
    scheduler = PrintScheduler()
    waiting = AsyncMock()

    def _real_spawn(coro, *, name=None):
        return asyncio.create_task(coro, name=name)

    idle_status = SimpleNamespace(state="IDLE", subtask_id=None, gcode_file=None, raw_data={})
    patches = [
        patch.object(scheduler_module.settings, "base_dir", ctx.base_dir),
        patch.object(archive_module.settings, "base_dir", ctx.base_dir),
        patch.object(archive_module.settings, "archive_dir", ctx.base_dir / "archive"),
        patch("backend.app.services.print_scheduler.async_session", ctx.session_maker),
        patch("backend.app.core.database.async_session", ctx.session_maker),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", MagicMock(return_value=idle_status)),
        patch(
            "backend.app.services.print_scheduler.printer_manager.is_awaiting_plate_clear",
            MagicMock(return_value=False),
        ),
        patch("backend.app.services.print_scheduler.printer_manager.start_print", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.set_awaiting_plate_clear", MagicMock()),
        patch("backend.app.services.print_scheduler.upload_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.print_scheduler.delete_file_async", AsyncMock(return_value=True)),
        patch(
            "backend.app.services.print_scheduler.get_ftp_retry_settings",
            AsyncMock(return_value=(False, 0, 0, 1.0)),
        ),
        patch("backend.app.services.print_scheduler.cache_3mf_download", MagicMock()),
        patch("backend.app.services.print_scheduler.spawn_background_task", _real_spawn),
        patch(
            "backend.app.services.notification_service.notification_service.on_queue_job_started",
            AsyncMock(),
        ),
        patch(
            "backend.app.services.notification_service.notification_service.on_queue_job_failed",
            AsyncMock(),
        ),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_waiting", waiting),
        patch("backend.app.services.mqtt_relay.mqtt_relay.on_queue_job_started", AsyncMock()),
        patch.object(scheduler, "_is_printer_idle", MagicMock(return_value=True)),
        patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
        patch.object(scheduler, "_power_off_if_needed", AsyncMock()),
        patch.object(scheduler, "_preheat_and_soak", AsyncMock()),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_watchdog_print_start", AsyncMock()),
        patch.object(scheduler, "_apply_keep_warm", AsyncMock()),
    ]
    with ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)
        scheduler.waiting_notification = waiting
        yield scheduler
        tasks = [task for (task, _pid) in scheduler._inflight.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class TestScheduler:
    @pytest.mark.asyncio
    async def test_a_pinned_job_waits_and_says_why(self, farm):
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await farm.set_stopped(printer_id, True)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        item = await farm.item(item_id)
        assert item.status == "pending"
        assert item.waiting_reason == "Busy: A1-01 (not taking jobs)"
        # The user turned it on; a "job waiting" alert would be noise.
        scheduler.waiting_notification.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_job_goes_out_after_resuming(self, farm):
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await farm.set_stopped(printer_id, True)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()
            await farm.set_stopped(printer_id, False)
            await scheduler.check_queue()

        item = await farm.item(item_id)
        assert item.status == "printing"
        assert item.waiting_reason is None

    @pytest.mark.asyncio
    async def test_a_model_job_goes_to_another_printer(self, farm):
        stopped_id = await farm.add_printer("A1-01")
        other_id = await farm.add_printer("A1-02")
        await farm.set_stopped(stopped_id, True)
        item_id = await farm.add_item(target_model="X1C")

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        item = await farm.item(item_id)
        assert item.printer_id == other_id
        assert item.status == "printing"

    @pytest.mark.asyncio
    async def test_a_model_job_waits_when_every_printer_is_stopped(self, farm):
        printer_id = await farm.add_printer("A1-01")
        await farm.set_stopped(printer_id, True)
        item_id = await farm.add_item(target_model="X1C")

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        item = await farm.item(item_id)
        assert item.status == "pending"
        assert item.printer_id is None
        assert item.waiting_reason == "Busy: A1-01"

    @pytest.mark.asyncio
    async def test_keep_warm_leaves_a_stopped_printer_alone(self, farm):
        """Keep-warm heats the bed of a busy printer with a job queued behind it.
        A stopped printer's job is not coming, so its bed must stay off."""
        printer_id = await farm.add_printer("A1-01")
        await farm.add_item(printer_id=printer_id)
        await farm.set_stopped(printer_id, True)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()
            keep_warm_busy = scheduler._apply_keep_warm.await_args.args[3]

        assert printer_id not in keep_warm_busy
