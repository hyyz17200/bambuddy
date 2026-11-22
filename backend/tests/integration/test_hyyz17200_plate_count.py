"""Plate count: hold a plate-changer printer once its clean plates are used up (hyyz17200)."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import backend.app.hyyz17200.models  # noqa: F401 - the fork's tables
from backend.app.hyyz17200 import plate_count, printer_intake
from backend.app.hyyz17200.models import PlatePrinter, PlateRun
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services import plate_clear
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401

URL = "/api/v1/hyyz17200/printers/plates"


@pytest.fixture(autouse=True)
def _reset():
    plate_count.apply_settings(plate_count.PlateCountSettings(enabled=True))
    plate_clear.load_overrides({})
    plate_count._held = frozenset()
    yield
    plate_count.apply_settings(plate_count.PlateCountSettings())
    plate_clear.load_overrides({})
    plate_count._held = frozenset()


def _utc(minutes_ago: float = 0) -> datetime:
    return datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)


async def _job(db, printer_id: int, status: str, *, started_minutes_ago: float = 0) -> PrintQueueItem:
    """A queue job as upstream leaves it after a dispatch: a run id and a start time."""
    item = PrintQueueItem(
        printer_id=printer_id,
        status=status,
        billing_run_id=str(uuid.uuid4()),
        started_at=_utc(started_minutes_ago),
        completed_at=None if status == "printing" else _utc(0),
    )
    db.add(item)
    await db.commit()
    return item


async def _finish(db, item: PrintQueueItem, status: str = "completed") -> None:
    item.status = status
    item.completed_at = _utc(0)
    await db.commit()


async def _plates(db, printer_id: int) -> int | None:
    row = await db.get(PlatePrinter, printer_id)
    await db.refresh(row)
    return row.plates


async def _counting(db, printer_factory, name="A1-01") -> int:
    printer = await printer_factory(name=name)
    await plate_count.settle(db)
    return printer.id


class TestWhoIsCounted:
    @pytest.mark.asyncio
    async def test_off_by_default(self, db_session, printer_factory):
        plate_count.apply_settings(plate_count.PlateCountSettings())
        printer = await printer_factory()

        await plate_count.settle(db_session)

        assert await db_session.get(PlatePrinter, printer.id) is None
        assert await plate_count.held_printer_ids(db_session) == set()

    @pytest.mark.asyncio
    async def test_a_plate_changer_starts_from_a_full_stack(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)

        assert await _plates(db_session, printer_id) == 10

    @pytest.mark.asyncio
    async def test_a_printer_cleared_by_hand_is_never_counted(self, db_session, printer_factory):
        """Where the plate-clear confirmation applies (a P1), whatever it is set to here."""
        p1 = await printer_factory(name="P1-01")
        plate_clear.set_override(p1.id, True)
        await plate_count.configure(db_session, [p1.id], disabled=False, capacity=None, default_capacity=False)

        assert await _plates(db_session, p1.id) is None
        overview = await plate_count.overview(db_session, lambda _pid: True)
        assert overview["printers"][0] | {"updated_at": None} == {
            "printer_id": p1.id,
            "applicable": False,
            "disabled": False,
            "capacity": None,
            "effective_capacity": 10,
            "counted": False,
            "plates": None,
            "in_use": 0,
            "available": None,
            "held": False,
            "updated_at": None,
            "updated_by": None,
        }

    @pytest.mark.asyncio
    async def test_the_app_wide_confirmation_counts_too(self, db_session, printer_factory):
        db_session.add(Settings(key="require_plate_clear", value="true"))
        await db_session.commit()
        follows = await printer_factory(name="P1-01")
        swaps = await printer_factory(name="A1-01")
        plate_clear.set_override(swaps.id, False)

        await plate_count.settle(db_session)

        assert await db_session.get(PlatePrinter, follows.id) is None
        assert await _plates(db_session, swaps.id) == 10

    @pytest.mark.asyncio
    async def test_switching_a_printer_off_and_on_starts_again_full(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 3, None)

        await plate_count.configure(db_session, [printer_id], disabled=True, capacity=None, default_capacity=False)
        assert await _plates(db_session, printer_id) is None
        await plate_count.configure(db_session, [printer_id], disabled=False, capacity=None, default_capacity=False)
        assert await _plates(db_session, printer_id) == 10

    @pytest.mark.asyncio
    async def test_turning_the_confirmation_on_lets_the_printer_go_at_once(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 0, None)
        assert await plate_count.held_printer_ids(db_session) == {printer_id}

        plate_clear.set_override(printer_id, True)

        assert await plate_count.held_printer_ids(db_session) == set()

    @pytest.mark.asyncio
    async def test_own_capacity(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)

        await plate_count.configure(db_session, [printer_id], disabled=None, capacity=6, default_capacity=False)
        assert await _plates(db_session, printer_id) == 6  # a full 10 cannot fit in 6
        await plate_count.set_plates(db_session, [printer_id], None, None)
        assert await _plates(db_session, printer_id) == 6

        await plate_count.configure(db_session, [printer_id], disabled=None, capacity=None, default_capacity=True)
        await plate_count.set_plates(db_session, [printer_id], None, None)
        assert await _plates(db_session, printer_id) == 10

    @pytest.mark.asyncio
    async def test_turning_the_feature_off_forgets_the_counts(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await _job(db_session, printer_id, "completed")
        await plate_count.settle(db_session)

        plate_count.apply_settings(plate_count.PlateCountSettings())
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) is None
        assert (await db_session.execute(select(PlateRun))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_deleting_the_printer_drops_its_rows(self, db_session, printer_factory):
        printer = await printer_factory()
        await plate_count.settle(db_session)
        await _job(db_session, printer.id, "completed")
        await plate_count.settle(db_session)

        await db_session.delete(printer)
        await db_session.commit()

        assert (await db_session.execute(select(PlatePrinter))).scalars().all() == []
        assert (await db_session.execute(select(PlateRun))).scalars().all() == []


class TestCounting:
    @pytest.mark.asyncio
    async def test_a_finished_job_takes_one_plate_once(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await _job(db_session, printer_id, "completed")

        await plate_count.settle(db_session)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 9

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["failed", "cancelled", "pending", "skipped"])
    async def test_a_job_that_did_not_finish_takes_none(self, db_session, printer_factory, status):
        """The plate stays on the bed; whoever deals with it leaves a usable one."""
        printer_id = await _counting(db_session, printer_factory)
        job = await _job(db_session, printer_id, "printing")
        await plate_count.settle(db_session)

        await _finish(db_session, job, status)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 10
        assert await plate_count.held_printer_ids(db_session) == set()

    @pytest.mark.asyncio
    async def test_a_job_sent_again_is_counted_again(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        job = await _job(db_session, printer_id, "completed")
        await plate_count.settle(db_session)

        job.status, job.billing_run_id = "completed", str(uuid.uuid4())
        await db_session.commit()
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 8

    @pytest.mark.asyncio
    async def test_jobs_from_before_counting_started_are_not_counted(self, db_session, printer_factory):
        printer = await printer_factory()
        await _job(db_session, printer.id, "completed", started_minutes_ago=120)

        await plate_count.settle(db_session)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer.id) == 10

    @pytest.mark.asyncio
    async def test_the_job_printing_when_counting_starts_is_one_of_the_stack(self, db_session, printer_factory):
        printer = await printer_factory()
        job = await _job(db_session, printer.id, "printing", started_minutes_ago=120)
        await plate_count.settle(db_session)

        await _finish(db_session, job)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer.id) == 9

    @pytest.mark.asyncio
    async def test_the_count_never_goes_below_zero(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 0, None)
        await _job(db_session, printer_id, "completed")

        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 0


class TestHold:
    @pytest.mark.asyncio
    async def test_held_with_no_plate_left(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        assert await plate_count.held_printer_ids(db_session) == set()

        await plate_count.set_plates(db_session, [printer_id], 0, None)

        assert await plate_count.held_printer_ids(db_session) == {printer_id}
        assert plate_count.is_held(printer_id)

    @pytest.mark.asyncio
    async def test_the_last_plate_is_held_while_it_prints(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 1, None)
        job = await _job(db_session, printer_id, "printing")

        assert await plate_count.held_printer_ids(db_session) == {printer_id}

        # Finished, not yet counted: the queue still must not send the next job.
        await _finish(db_session, job)
        assert await plate_count.held_printer_ids(db_session) == {printer_id}

        await plate_count.settle(db_session)
        assert await _plates(db_session, printer_id) == 0
        assert await plate_count.held_printer_ids(db_session) == {printer_id}

    @pytest.mark.asyncio
    async def test_a_failed_last_job_frees_the_printer(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 1, None)
        job = await _job(db_session, printer_id, "printing")

        await _finish(db_session, job, "failed")

        assert await plate_count.held_printer_ids(db_session) == set()

    @pytest.mark.asyncio
    async def test_a_maintenance_job_that_uses_no_plate(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 1, None)
        item = PrintQueueItem(printer_id=printer_id, status="pending")
        db_session.add(item)
        await db_session.commit()
        await plate_count.exempt(db_session, item.id, printer_id)

        item.status, item.billing_run_id, item.started_at = "printing", str(uuid.uuid4()), _utc(0)
        await db_session.commit()
        assert await plate_count.held_printer_ids(db_session) == set()
        await plate_count.settle(db_session)

        await _finish(db_session, item)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 1
        assert await plate_count.held_printer_ids(db_session) == set()


class TestRefill:
    @pytest.mark.asyncio
    async def test_refill_to_full_and_to_a_number(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 0, None)

        assert await plate_count.set_plates(db_session, [printer_id], None, "alice") == [printer_id]
        assert await _plates(db_session, printer_id) == 10
        await plate_count.set_plates(db_session, [printer_id], 4, "alice")
        assert await _plates(db_session, printer_id) == 4
        await plate_count.set_plates(db_session, [printer_id], 40, "alice")
        assert await _plates(db_session, printer_id) == 10  # no more than it holds

        row = await db_session.get(PlatePrinter, printer_id)
        assert row.updated_by == "alice"

    @pytest.mark.asyncio
    async def test_a_printer_not_counted_is_skipped(self, db_session, printer_factory):
        p1 = await printer_factory(name="P1-01")
        plate_clear.set_override(p1.id, True)

        assert await plate_count.set_plates(db_session, [p1.id], None, None) == []

    @pytest.mark.asyncio
    async def test_the_job_printing_during_a_refill_uses_a_plate_of_the_new_stack(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await plate_count.set_plates(db_session, [printer_id], 1, None)
        job = await _job(db_session, printer_id, "printing")

        await plate_count.set_plates(db_session, [printer_id], None, None)
        await _finish(db_session, job)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 9

    @pytest.mark.asyncio
    async def test_a_job_that_finished_before_the_refill_is_not_taken_off_it(self, db_session, printer_factory):
        printer_id = await _counting(db_session, printer_factory)
        await _job(db_session, printer_id, "completed")  # not counted yet

        await plate_count.set_plates(db_session, [printer_id], None, None)
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 10


class TestApi:
    @pytest.mark.asyncio
    async def test_overview_and_refill(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="A1-01")
        await plate_count.settle(db_session)

        body = (await async_client.get(URL)).json()
        assert body["enabled"] is True
        assert body["default_capacity"] == 10
        assert body["printers"][0]["counted"] is True
        assert body["printers"][0]["plates"] == 10

        response = await async_client.post(f"/api/v1/hyyz17200/printers/{printer.id}/plates", json={"plates": 0})
        assert response.status_code == 200
        entry = (await async_client.get(URL)).json()["printers"][0]
        assert (entry["plates"], entry["available"], entry["held"]) == (0, 0, True)

        response = await async_client.post(f"/api/v1/hyyz17200/printers/{printer.id}/plates", json={})
        assert response.status_code == 200
        assert (await async_client.get(URL)).json()["printers"][0]["plates"] == 10

    @pytest.mark.asyncio
    async def test_refilling_a_printer_not_counted(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="P1-01")
        plate_clear.set_override(printer.id, True)

        response = await async_client.post(f"/api/v1/hyyz17200/printers/{printer.id}/plates", json={})
        assert response.status_code == 409
        assert response.json()["detail"] == "not_counted"
        response = await async_client.post("/api/v1/hyyz17200/printers/9999/plates", json={})
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_refill_many(self, async_client: AsyncClient, printer_factory, db_session):
        a1 = await printer_factory(name="A1-01")
        p1 = await printer_factory(name="P1-01")
        plate_clear.set_override(p1.id, True)
        await plate_count.settle(db_session)

        response = await async_client.post(f"{URL}/set", json={"printer_ids": [a1.id, p1.id], "plates": 7})

        assert response.json() == {"updated": [a1.id], "skipped": [p1.id]}
        assert await _plates(db_session, a1.id) == 7
        response = await async_client.post(f"{URL}/set", json={"printer_ids": [9999]})
        assert response.status_code == 404
        response = await async_client.post(f"{URL}/set", json={"printer_ids": [a1.id], "plates": -1})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_config(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="A1-01")

        response = await async_client.post(f"{URL}/config", json={"printer_ids": [printer.id], "capacity": 8})
        assert response.status_code == 200
        entry = (await async_client.get(URL)).json()["printers"][0]
        assert (entry["capacity"], entry["effective_capacity"], entry["plates"]) == (8, 8, 8)

        await async_client.post(f"{URL}/config", json={"printer_ids": [printer.id], "disabled": True})
        entry = (await async_client.get(URL)).json()["printers"][0]
        assert (entry["disabled"], entry["counted"], entry["capacity"]) == (True, False, 8)

        await async_client.post(f"{URL}/config", json={"printer_ids": [printer.id], "default_capacity": True})
        assert (await async_client.get(URL)).json()["printers"][0]["capacity"] is None


class TestScheduler:
    async def _empty(self, farm, printer_id: int) -> None:  # noqa: F811
        async with farm.session_maker() as db:
            await plate_count.settle(db)
            await plate_count.set_plates(db, [printer_id], 0, None)

    @pytest.mark.asyncio
    async def test_a_pinned_job_waits_and_says_why(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await self._empty(farm, printer_id)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        item = await farm.item(item_id)
        assert item.status == "pending"
        assert item.waiting_reason == "Busy: A1-01 (no clean plate left)"
        scheduler.waiting_notification.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_stopped_reads_as_stopped(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await self._empty(farm, printer_id)
        await farm.set_stopped(printer_id, True)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        assert (await farm.item(item_id)).waiting_reason == "Busy: A1-01 (not taking jobs)"

    @pytest.mark.asyncio
    async def test_a_model_job_goes_to_a_printer_with_plates(self, farm):  # noqa: F811
        empty_id = await farm.add_printer("A1-01")
        other_id = await farm.add_printer("A1-02")
        await self._empty(farm, empty_id)
        item_id = await farm.add_item(target_model="X1C")

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        assert (await farm.item(item_id)).printer_id == other_id

    @pytest.mark.asyncio
    async def test_a_dispatched_job_takes_a_plate_when_it_finishes(self, farm):  # noqa: F811
        """Upstream's dispatch gives the job a run id; its completion takes the plate."""
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        async with farm.session_maker() as db:
            await plate_count.settle(db)
            await plate_count.set_plates(db, [printer_id], 1, None)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()
        second_id = await farm.add_item(printer_id=printer_id, position=1)

        item = await farm.item(item_id)
        assert item.status == "printing"
        assert item.billing_run_id
        async with farm.session_maker() as db:
            assert await printer_intake.queue_skipped_printer_ids(db) == {printer_id}
            job = await db.get(PrintQueueItem, item_id)
            job.status, job.completed_at = "completed", _utc(0)
            await db.commit()
            await plate_count.settle(db)
            assert (await db.get(PlatePrinter, printer_id)).plates == 0

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        second = await farm.item(second_id)
        assert second.status == "pending"
        assert second.waiting_reason == "Busy: A1-01 (no clean plate left)"


class TestMaintenance:
    @pytest.mark.asyncio
    async def test_a_job_sent_without_using_a_plate(self, db_session, printer_factory):
        from backend.app.hyyz17200 import maintenance_jobs

        printer_id = await _counting(db_session, printer_factory)
        item = PrintQueueItem(printer_id=printer_id, status="pending")
        db_session.add(item)
        await db_session.commit()

        await maintenance_jobs._exempt_from_plate_count(db_session, item.id, printer_id)
        item.status, item.billing_run_id, item.started_at = "completed", str(uuid.uuid4()), _utc(0)
        item.completed_at = _utc(0)
        await db_session.commit()
        await plate_count.settle(db_session)

        assert await _plates(db_session, printer_id) == 10

    def test_send_takes_the_choice(self):
        import inspect

        from backend.app.hyyz17200 import maintenance_jobs
        from backend.app.hyyz17200.api import MaintenanceJobSend

        assert inspect.signature(maintenance_jobs.send).parameters["uses_plate"].default is True
        assert MaintenanceJobSend(library_file_id=1).uses_plate is True


class TestUpstreamContracts:
    """What this reads from upstream's queue. A change here breaks the count quietly."""

    def test_the_dispatch_gives_each_run_its_own_id(self):
        import inspect

        from backend.app.services.print_scheduler import PrintScheduler

        source = inspect.getsource(PrintScheduler)
        # The move to "printing" writes a new run id with it.
        assert 'status="printing"' in source
        assert "billing_run_id = str(uuid.uuid4())" in source
        assert "billing_run_id=billing_run_id" in source

    def test_a_finished_print_marks_its_job_completed(self):
        import inspect

        import backend.app.main as main

        source = inspect.getsource(main)
        assert 'queue_status = data.get("status", "completed")' in source
        assert 'if queue_status == "aborted":' in source
        assert "item.status = queue_status" in source

    def test_the_queue_asks_for_the_skipped_printers(self):
        import inspect

        from backend.app.services.print_scheduler import PrintScheduler

        assert "hyyz17200_intake.queue_skipped_printer_ids(db)" in inspect.getsource(PrintScheduler.check_queue)
