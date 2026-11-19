"""Maintenance G-code: one file from the maintenance folder, sent now (hyyz17200)."""

import asyncio
import inspect
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.hyyz17200 import enhanced_settings, maintenance_jobs, plate_swap
from backend.app.hyyz17200.models import PlateSwapDispatch
from backend.app.hyyz17200.models.setting import Hyyz17200Setting
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem

# Same in-memory farm and mocked printers as the stop-taking-jobs tests.
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401


def _url(printer_id: int) -> str:
    return f"/api/v1/hyyz17200/printers/{printer_id}/maintenance-job"


async def _folder(db, name: str, parent_id: int | None = None) -> LibraryFolder:
    folder = LibraryFolder(name=name, parent_id=parent_id)
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return folder


async def _file(db, folder_id: int | None, filename: str = "swap.gcode.3mf", model: str | None = "X1C") -> LibraryFile:
    library_file = LibraryFile(
        folder_id=folder_id,
        filename=filename,
        file_path=f"library/{filename}",
        file_size=10,
        file_type="3mf",
        file_metadata={"sliced_for_model": model} if model else {},
    )
    db.add(library_file)
    await db.commit()
    await db.refresh(library_file)
    return library_file


async def _set_folder(db, folder_id: int | None) -> None:
    value = maintenance_jobs.MaintenanceSettings(folder_id=folder_id)
    await enhanced_settings.write_section(db, maintenance_jobs.SECTION, value)


@pytest.fixture
def launched():
    """Ready printer, dispatch recorded instead of run."""
    calls: list[tuple[int, int, bool]] = []
    with (
        patch.object(maintenance_jobs, "blocker", AsyncMock(return_value=None)),
        patch.object(maintenance_jobs, "_launch", side_effect=lambda *args: calls.append(args)),
    ):
        yield calls


class TestApi:
    @pytest.mark.asyncio
    async def test_sends_a_file_from_a_subfolder(
        self, async_client: AsyncClient, db_session, printer_factory, launched
    ):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        sub = await _folder(db_session, "Swaps", root.id)
        library_file = await _file(db_session, sub.id)
        await _set_folder(db_session, root.id)

        with patch(
            "backend.app.services.print_scheduler.scheduler._compute_ams_mapping_for_printer",
            AsyncMock(return_value=[2]),
        ):
            response = await async_client.post(
                _url(printer.id), json={"library_file_id": library_file.id, "clears_plate": True}
            )

        assert response.status_code == 200, response.text
        item_id = response.json()["queue_item_id"]
        assert launched == [(item_id, printer.id, True)]
        item = await db_session.get(PrintQueueItem, item_id)
        await db_session.refresh(item)
        assert item.printer_id == printer.id
        assert item.library_file_id == library_file.id
        assert item.status == "pending"
        # No queue pass picks it up; only this send starts it.
        assert item.manual_start is True
        assert item.gcode_injection is False
        assert item.bed_levelling == "off"
        assert item.timelapse is False
        assert json.loads(item.ams_mapping) == [2]

    @pytest.mark.asyncio
    async def test_no_match_sends_without_a_mapping(
        self, async_client: AsyncClient, db_session, printer_factory, launched
    ):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        library_file = await _file(db_session, root.id)
        await _set_folder(db_session, root.id)

        with patch(
            "backend.app.services.print_scheduler.scheduler._compute_ams_mapping_for_printer",
            AsyncMock(side_effect=RuntimeError("no trays")),
        ):
            response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        assert response.status_code == 200, response.text
        item = await db_session.get(PrintQueueItem, response.json()["queue_item_id"])
        assert item.ams_mapping is None
        assert launched[0][2] is False

    @pytest.mark.asyncio
    async def test_no_folder_set(self, async_client: AsyncClient, db_session, printer_factory, launched):
        printer = await printer_factory(model="X1C")
        library_file = await _file(db_session, None)

        response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        assert response.status_code == 400
        assert response.json()["detail"] == "no_folder"
        assert launched == []

    @pytest.mark.asyncio
    async def test_a_file_outside_the_folder(self, async_client: AsyncClient, db_session, printer_factory, launched):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        elsewhere = await _folder(db_session, "Prints")
        library_file = await _file(db_session, elsewhere.id)
        await _set_folder(db_session, root.id)

        response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        assert response.status_code == 400
        assert response.json()["detail"] == "not_in_folder"
        assert (await db_session.execute(select(PrintQueueItem))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_a_file_for_another_model(self, async_client: AsyncClient, db_session, printer_factory, launched):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        library_file = await _file(db_session, root.id, model="A1")
        await _set_folder(db_session, root.id)

        response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        assert response.status_code == 400
        assert response.json()["detail"] == "wrong_model"

    @pytest.mark.asyncio
    async def test_an_unsliced_file(self, async_client: AsyncClient, db_session, printer_factory, launched):
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        library_file = await _file(db_session, root.id, filename="swap.3mf")
        await _set_folder(db_session, root.id)

        response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        assert response.status_code == 400
        assert response.json()["detail"] == "not_sliced"

    @pytest.mark.asyncio
    async def test_a_printer_that_is_not_ready(self, async_client: AsyncClient, db_session, printer_factory):
        """Refused rather than held: a held job would go out whenever the printer came free."""
        printer = await printer_factory(model="X1C")
        root = await _folder(db_session, "Maintenance")
        library_file = await _file(db_session, root.id)
        await _set_folder(db_session, root.id)

        with patch.object(maintenance_jobs, "_launch") as launch:
            response = await async_client.post(_url(printer.id), json={"library_file_id": library_file.id})

        # Nothing is connected in the test app.
        assert response.status_code == 409
        assert response.json()["detail"] == "offline"
        launch.assert_not_called()
        assert (await db_session.execute(select(PrintQueueItem))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_unknown_printer(self, async_client: AsyncClient):
        response = await async_client.post(_url(9999), json={"library_file_id": 1})
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_the_folder_is_an_enhanced_setting(self, async_client: AsyncClient, db_session):
        assert (await async_client.get("/api/v1/hyyz17200/settings")).json()["maintenance"] == {"folder_id": None}

        response = await async_client.put("/api/v1/hyyz17200/settings/maintenance", json={"folder_id": 7})

        assert response.status_code == 200
        assert (await db_session.get(Hyyz17200Setting, "maintenance")) is not None


class TestReadiness:
    @pytest.mark.asyncio
    async def test_drying_blocks(self, db_session, printer_factory):
        printer = await printer_factory()
        with (
            patch.object(maintenance_jobs.calibration_batch, "_blocker", MagicMock(return_value=None)),
            patch(
                "backend.app.services.print_scheduler.scheduler._drying_in_progress",
                {printer.id: 1.0},
            ),
            patch(
                "backend.app.services.print_scheduler.scheduler._drying_is_only_parked",
                MagicMock(return_value=False),
            ),
        ):
            assert await maintenance_jobs.blocker(db_session, printer) == "drying"

    @pytest.mark.asyncio
    async def test_an_interlock_blocks(self, db_session, printer_factory):
        printer = await printer_factory()
        with (
            patch.object(maintenance_jobs.calibration_batch, "_blocker", MagicMock(return_value=None)),
            patch(
                "backend.app.services.ha_sensor_manager.ha_sensor_manager.blocked_printers",
                AsyncMock(return_value={printer.id: "door open"}),
            ),
        ):
            assert await maintenance_jobs.blocker(db_session, printer) == "interlock"

    @pytest.mark.asyncio
    async def test_a_plate_waiting_to_be_cleared_does_not_block(self, db_session, printer_factory):
        """The maintenance job is often the swap that clears it."""
        printer = await printer_factory()
        with patch.object(maintenance_jobs.calibration_batch, "_blocker", MagicMock(return_value=None)) as check:
            assert await maintenance_jobs.blocker(db_session, printer) is None
        assert check.call_args.kwargs == {"require_plate_clear": False}


async def _maintenance_item(ctx, printer_id: int) -> int:
    item_id = await ctx.add_item(printer_id=printer_id)
    async with ctx.session_maker() as db:
        await db.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(manual_start=True))
        await db.commit()
    return item_id


class TestDispatch:
    @pytest.mark.asyncio
    async def test_a_stopped_printer_gets_it_and_the_plate_is_recorded_clear(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        await farm.set_stopped(printer_id, True)
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            with (
                patch("backend.app.services.print_scheduler.scheduler", scheduler),
                patch.object(maintenance_jobs, "async_session", farm.session_maker),
            ):
                maintenance_jobs._launch(item_id, printer_id, True)
                task, pid = scheduler._inflight[item_id]
                assert pid == printer_id
                await task

        assert (await farm.item(item_id)).status == "printing"
        async with farm.session_maker() as db:
            assert await db.get(PlateSwapDispatch, item_id) is not None
        assert item_id not in plate_swap._plate_clearing

    @pytest.mark.asyncio
    async def test_without_clears_plate_no_row(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            with (
                patch("backend.app.services.print_scheduler.scheduler", scheduler),
                patch.object(maintenance_jobs, "async_session", farm.session_maker),
            ):
                maintenance_jobs._launch(item_id, printer_id, False)
                await scheduler._inflight[item_id][0]

        assert (await farm.item(item_id)).status == "printing"
        async with farm.session_maker() as db:
            assert await db.get(PlateSwapDispatch, item_id) is None

    @pytest.mark.asyncio
    async def test_a_job_that_did_not_start_is_failed_not_left_pending(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            busy = MagicMock(state="RUNNING", subtask_id=None, gcode_file=None, raw_data={})
            with (
                patch("backend.app.services.print_scheduler.scheduler", scheduler),
                patch.object(maintenance_jobs, "async_session", farm.session_maker),
                # The busy guard in _start_print leaves the job pending.
                patch(
                    "backend.app.services.print_scheduler.printer_manager.get_status",
                    MagicMock(return_value=busy),
                ),
            ):
                maintenance_jobs._launch(item_id, printer_id, True)
                await scheduler._inflight[item_id][0]

        item = await farm.item(item_id)
        assert item.status == "failed"
        assert item.error_message == maintenance_jobs.NOT_SENT_MESSAGE
        assert item_id not in plate_swap._plate_clearing

    @pytest.mark.asyncio
    async def test_a_queue_pass_never_picks_it(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await _maintenance_item(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        assert (await farm.item(item_id)).status == "pending"


class TestLock:
    @pytest.mark.asyncio
    async def test_install_wraps_check_queue_once(self):
        from backend.app.services.print_scheduler import scheduler

        maintenance_jobs.install()
        wrapped = scheduler.check_queue
        maintenance_jobs.install()

        assert scheduler.check_queue is wrapped
        assert getattr(wrapped, "hyyz17200", False) is True

    @pytest.mark.asyncio
    async def test_a_send_waits_for_the_running_pass(self):
        order: list[str] = []
        release = asyncio.Event()

        async def slow_pass() -> bool:
            order.append("pass start")
            await release.wait()
            order.append("pass end")
            return False

        scheduler = MagicMock()
        scheduler.check_queue = slow_pass
        with patch("backend.app.services.print_scheduler.scheduler", scheduler):
            maintenance_jobs.install()
            running = asyncio.create_task(scheduler.check_queue())
            await asyncio.sleep(0)

            async def send() -> None:
                async with maintenance_jobs._lock():
                    order.append("send")

            sending = asyncio.create_task(send())
            await asyncio.sleep(0)
            release.set()
            await asyncio.gather(running, sending)

        assert order == ["pass start", "pass end", "send"]


class TestUpstreamContracts:
    """What this patch borrows from upstream. A rename fails here, not on a printer."""

    def test_the_wrapper_is_installed(self):
        from backend.app.main import app  # noqa: F401 - register() runs on import
        from backend.app.services.print_scheduler import scheduler

        assert getattr(scheduler.check_queue, "hyyz17200", False) is True

    def test_scheduler_internals(self):
        from backend.app.services.print_scheduler import PrintScheduler, scheduler

        assert list(inspect.signature(PrintScheduler._dispatch_one).parameters)[:3] == [
            "self",
            "item_id",
            "selected_printer_id",
        ]
        assert list(inspect.signature(PrintScheduler._compute_ams_mapping_for_printer).parameters)[:4] == [
            "self",
            "db",
            "printer_id",
            "item",
        ]
        assert isinstance(scheduler._inflight, dict)
        assert isinstance(scheduler._drying_in_progress, dict)
        assert callable(scheduler._drying_is_only_parked)

    def test_queue_route(self):
        from backend.app.api.routes.print_queue import add_to_queue
        from backend.app.schemas.print_queue import PrintQueueItemCreate

        params = set(inspect.signature(add_to_queue).parameters)
        assert {"data", "db", "current_user", "printer_scope", "review_required", "actor"} <= params
        fields = set(PrintQueueItemCreate.model_fields)
        assert {
            "manual_start",
            "insert_at_top",
            "bed_levelling",
            "flow_cali",
            "vibration_cali",
            "layer_inspect",
            "timelapse",
            "nozzle_offset_cali",
            "preheat_override",
            "gcode_injection",
            "skip_filament_check",
        } <= fields

    def test_the_scheduler_records_every_dispatch(self):
        """The plate-clear row is written from _start_print's call to record_dispatch."""
        from backend.app.services.print_scheduler import PrintScheduler

        assert "hyyz17200_plate_swap.record_dispatch(db, item.id" in inspect.getsource(PrintScheduler._start_print)
