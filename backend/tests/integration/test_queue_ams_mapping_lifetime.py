"""A stored AMS mapping must not outlive the printer it was read from.

Tray ids are per-printer: the same spool is tray 0 on one machine, tray 3 on the
next and the external spool (254) on a third. The scheduler keeps any mapping
that looks resolved, so a mapping left on a row after the row stops pointing at
that printer is dispatched as-is, to whichever printer the job reaches next.

These cover the routes that can leave one behind. The scheduler's own guard is
in tests/unit/test_scheduler_model_stale_ams_mapping.py.
"""

import json

import pytest
from httpx import AsyncClient

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer


@pytest.fixture
async def printer_factory(db_session):
    _counter = [0]

    async def _create_printer(**kwargs):
        _counter[0] += 1
        counter = _counter[0]
        defaults = {
            "name": f"Mapping Test Printer {counter}",
            "ip_address": f"192.168.7.{counter}",
            "serial_number": f"TESTMAP{counter:04d}",
            "access_code": "12345678",
            "model": "A1",
        }
        defaults.update(kwargs)
        printer = Printer(**defaults)
        db_session.add(printer)
        await db_session.commit()
        await db_session.refresh(printer)
        return printer

    return _create_printer


@pytest.fixture
async def archive(db_session):
    archive = PrintArchive(
        filename="mapping_test.3mf",
        print_name="Mapping Test",
        file_path="/tmp/mapping_test.3mf",
        file_size=1024,
        content_hash="mappinghash0001",
        status="completed",
    )
    db_session.add(archive)
    await db_session.commit()
    await db_session.refresh(archive)
    return archive


@pytest.fixture
async def queue_item_factory(db_session, archive):
    _counter = [0]

    async def _create_item(**kwargs):
        _counter[0] += 1
        defaults = {"status": "pending", "position": _counter[0], "archive_id": archive.id}
        defaults.update(kwargs)
        if isinstance(defaults.get("ams_mapping"), list):
            defaults["ams_mapping"] = json.dumps(defaults["ams_mapping"])
        item = PrintQueueItem(**defaults)
        db_session.add(item)
        await db_session.commit()
        await db_session.refresh(item)
        return item

    return _create_item


class TestCreate:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_model_based_item_does_not_store_a_supplied_mapping(
        self, async_client: AsyncClient, printer_factory, archive
    ):
        """There is no printer for the tray ids to refer to yet."""
        await printer_factory()

        response = await async_client.post(
            "/api/v1/queue/",
            json={"target_model": "A1", "archive_id": archive.id, "ams_mapping": [254]},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["printer_id"] is None
        assert result["ams_mapping"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_specific_printer_item_keeps_its_mapping(self, async_client: AsyncClient, printer_factory, archive):
        printer = await printer_factory()

        response = await async_client.post(
            "/api/v1/queue/",
            json={"printer_id": printer.id, "archive_id": archive.id, "ams_mapping": [254]},
        )

        assert response.status_code == 200
        assert response.json()["ams_mapping"] == [254]


class TestSingleEdit:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_moving_a_job_to_any_model_clears_the_mapping_the_client_left_out(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        """What the edit dialog used to send: the switch to a model, and no
        ams_mapping key at all."""
        printer = await printer_factory()
        item = await queue_item_factory(printer_id=printer.id, ams_mapping=[254])

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}",
            json={"printer_id": None, "target_model": "A1", "target_location": "A1-BLK"},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["printer_id"] is None
        assert result["target_model"] == "A1"
        assert result["ams_mapping"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_moving_a_job_to_any_model_ignores_a_mapping_sent_with_it(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        printer = await printer_factory()
        item = await queue_item_factory(printer_id=printer.id, ams_mapping=[0])

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}",
            json={"printer_id": None, "target_model": "A1", "ams_mapping": [3]},
        )

        assert response.status_code == 200
        assert response.json()["ams_mapping"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_any_edit_of_an_unassigned_model_job_clears_a_mapping_already_on_it(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        """Rows written before the routes stopped storing one."""
        await printer_factory()
        item = await queue_item_factory(printer_id=None, target_model="A1", ams_mapping=[254])

        response = await async_client.patch(f"/api/v1/queue/{item.id}", json={"target_location": "A1-BLK"})

        assert response.status_code == 200
        assert response.json()["ams_mapping"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_moving_a_job_to_another_printer_without_a_mapping_clears_the_old_one(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        origin = await printer_factory()
        other = await printer_factory()
        item = await queue_item_factory(printer_id=origin.id, ams_mapping=[3])

        response = await async_client.patch(f"/api/v1/queue/{item.id}", json={"printer_id": other.id})

        assert response.status_code == 200
        result = response.json()
        assert result["printer_id"] == other.id
        assert result["ams_mapping"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_moving_a_job_to_another_printer_stores_the_mapping_sent_for_it(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        origin = await printer_factory()
        other = await printer_factory()
        item = await queue_item_factory(printer_id=origin.id, ams_mapping=[3])

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}", json={"printer_id": other.id, "ams_mapping": [254]}
        )

        assert response.status_code == 200
        assert response.json()["ams_mapping"] == [254]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_editing_a_job_that_stays_on_its_printer_keeps_the_mapping(
        self, async_client: AsyncClient, printer_factory, queue_item_factory
    ):
        """A manual tray pick survives an unrelated edit, with or without the
        client re-sending the printer it is already on."""
        printer = await printer_factory()
        item = await queue_item_factory(printer_id=printer.id, ams_mapping=[3])

        response = await async_client.patch(f"/api/v1/queue/{item.id}", json={"timelapse": True})
        assert response.status_code == 200
        assert response.json()["ams_mapping"] == [3]

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}", json={"printer_id": printer.id, "manual_start": True}
        )
        assert response.status_code == 200
        assert response.json()["ams_mapping"] == [3]


class TestBulkEdit:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reassigning_printers_clears_only_the_mappings_that_moved(
        self, async_client: AsyncClient, printer_factory, queue_item_factory, db_session
    ):
        origin = await printer_factory()
        target = await printer_factory()
        moved = await queue_item_factory(printer_id=origin.id, ams_mapping=[3])
        already_there = await queue_item_factory(printer_id=target.id, ams_mapping=[254])

        response = await async_client.patch(
            "/api/v1/queue/bulk",
            json={"item_ids": [moved.id, already_there.id], "printer_id": target.id},
        )

        assert response.status_code == 200
        assert response.json()["updated_count"] == 2
        await db_session.refresh(moved)
        await db_session.refresh(already_there)
        assert moved.printer_id == target.id
        assert moved.ams_mapping is None
        assert json.loads(already_there.ams_mapping) == [254]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unassigning_clears_the_mapping(
        self, async_client: AsyncClient, printer_factory, queue_item_factory, db_session
    ):
        printer = await printer_factory()
        item = await queue_item_factory(printer_id=printer.id, ams_mapping=[3])

        response = await async_client.patch("/api/v1/queue/bulk", json={"item_ids": [item.id], "printer_id": None})

        assert response.status_code == 200
        await db_session.refresh(item)
        assert item.printer_id is None
        assert item.ams_mapping is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_change_that_is_not_about_the_printer_keeps_the_mapping(
        self, async_client: AsyncClient, printer_factory, queue_item_factory, db_session
    ):
        printer = await printer_factory()
        item = await queue_item_factory(printer_id=printer.id, ams_mapping=[3])

        response = await async_client.patch("/api/v1/queue/bulk", json={"item_ids": [item.id], "timelapse": True})

        assert response.status_code == 200
        await db_session.refresh(item)
        assert json.loads(item.ams_mapping) == [3]
