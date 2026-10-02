"""A model-based job must not print from another printer's trays.

Tray ids are per-printer. The reporter's farm has three A1s in one location, all
loaded with the same black PETG:

    A1-002  AMS tray 0      -> [0]
    A1-003  AMS tray 3      -> [3]
    A1-016  external spool  -> [254]

An "any A1" job was sitting in the queue with ``printer_id = null`` and
``ams_mapping = [254]``, left there by an edit that moved it off a specific
printer without clearing the mapping. The scheduler handed it to A1-003, saw a
resolved mapping, kept it, and the printer stopped on "External filament is
missing" (HMS 07FF-2000-0002-0002) with the right spool sitting in its AMS.

These run the real ``_ensure_ams_mapping`` — it is the function that keeps a
resolved mapping, so mocking it would hide exactly what is under test.
"""

from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler

# printer id -> where that printer holds the black PETG
TRAYS = {2: [0], 3: [3], 16: [254]}


@pytest.fixture
async def queue_db():
    """In-memory DB with the three A1s."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        db.add_all(
            Printer(
                id=printer_id,
                name=f"A1-{printer_id:03d}",
                serial_number=f"A1{printer_id:05d}",
                ip_address=f"10.0.0.{printer_id}",
                access_code="x",
                model="A1",
                location="A1-BLK",
                is_active=True,
            )
            for printer_id in TRAYS
        )
        await db.commit()

    try:
        yield SimpleNamespace(session_maker=session_maker)
    finally:
        await engine.dispose()


async def _add_library_file(db, model="A1"):
    lib = LibraryFile(
        filename=f"job_{model}.gcode.3mf",
        file_path=f"/library/job_{model}.gcode.3mf",
        file_size=10,
        file_type="gcode.3mf",
        file_metadata={"sliced_for_model": model},
    )
    db.add(lib)
    await db.flush()
    return lib


async def _add_model_item(ctx, ams_mapping):
    async with ctx.session_maker() as db:
        lib = await _add_library_file(db)
        item = PrintQueueItem(
            status="pending",
            position=1,
            target_model="A1",
            target_location="A1-BLK",
            library_file_id=lib.id,
            ams_mapping=ams_mapping,
        )
        db.add(item)
        await db.commit()
        return item.id


class _Killed(BaseException):
    """The process going away mid-pass. Not an Exception, so nothing in the
    scheduler catches it and tidies up on the way out."""


async def _run_check_queue(ctx, scheduler, printer_id, assigned_notification=None):
    """One scheduler pass in which the matcher offers `printer_id`."""

    async def _compute(db, pid, item):
        return TRAYS[pid]

    compute = AsyncMock(side_effect=_compute)
    patches = [
        patch("backend.app.services.print_scheduler.async_session", ctx.session_maker),
        patch("backend.app.core.database.async_session", ctx.session_maker),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", MagicMock(return_value=None)),
        patch(
            "backend.app.services.notification_service.notification_service.on_queue_job_waiting",
            AsyncMock(),
        ),
        patch(
            "backend.app.services.notification_service.notification_service.on_queue_job_assigned",
            assigned_notification or AsyncMock(),
        ),
        patch.object(scheduler, "_find_idle_printer_for_model", AsyncMock(return_value=(printer_id, None))),
        # Only the fixed-printer branch asks; the matcher above answers for
        # the model-based one.
        patch.object(scheduler, "_is_printer_idle", MagicMock(return_value=True)),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_compute_ams_mapping_for_printer", compute),
        patch.object(scheduler, "_block_on_filament_deficit", AsyncMock(return_value=False)),
        patch.object(scheduler, "_launch_uploads", MagicMock()),
    ]
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        await scheduler.check_queue()
    return compute


async def _get_item(ctx, item_id):
    async with ctx.session_maker() as db:
        return (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()


@pytest.mark.asyncio
@pytest.mark.parametrize(("printer_id", "expected"), [(2, "[0]"), (3, "[3]"), (16, "[254]")])
async def test_model_job_gets_the_mapping_of_the_printer_it_lands_on(queue_db, printer_id, expected):
    """Nothing stored: each printer resolves the same job to its own tray,
    the external spool included."""
    item_id = await _add_model_item(queue_db, None)

    await _run_check_queue(queue_db, PrintScheduler(), printer_id)

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == printer_id
    assert item.ams_mapping == expected


@pytest.mark.asyncio
async def test_leftover_external_mapping_is_not_sent_to_a_printer_with_the_spool_in_its_ams(queue_db):
    """The reported failure: [254] left on the row, job assigned to A1-003."""
    item_id = await _add_model_item(queue_db, "[254]")

    await _run_check_queue(queue_db, PrintScheduler(), 3)

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == 3
    assert item.ams_mapping == "[3]"


@pytest.mark.asyncio
async def test_leftover_ams_mapping_is_not_sent_to_a_printer_feeding_from_the_external_spool(queue_db):
    """The same leak the other way round. External is a legitimate answer for
    the printer that has it; the fix is not "prefer the AMS"."""
    item_id = await _add_model_item(queue_db, "[3]")

    await _run_check_queue(queue_db, PrintScheduler(), 16)

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == 16
    assert item.ams_mapping == "[254]"


@pytest.mark.asyncio
async def test_interrupted_assignment_does_not_leave_the_old_mapping_on_the_new_printer(queue_db):
    """The assignment notification commits the session after each provider. If
    the process stops there, what was committed is what the next start finds —
    and a row that has a printer goes down the fixed-printer branch, which
    keeps any mapping that looks resolved."""
    item_id = await _add_model_item(queue_db, "[254]")

    async def _commit_then_die(*, db, **_):
        await db.commit()
        raise _Killed

    with pytest.raises(_Killed):
        await _run_check_queue(
            queue_db, PrintScheduler(), 3, assigned_notification=AsyncMock(side_effect=_commit_then_die)
        )

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == 3, "the assignment was persisted"
    assert item.ams_mapping is None, "and the old printer's mapping did not go with it"

    # The next start: the row is pinned to A1-003 now.
    await _run_check_queue(queue_db, PrintScheduler(), 3)

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == 3
    assert item.ams_mapping == "[3]"


@pytest.mark.asyncio
async def test_cross_model_candidate_mapping_is_not_sent_to_whichever_printer_wins(queue_db):
    """A candidate names a model (#671), and there are three A1s here. A
    mapping stored on it says nothing about which of them it was read from."""
    async with queue_db.session_maker() as db:
        lib = await _add_library_file(db)
        item = PrintQueueItem(status="pending", position=1, target_model="A1", ams_mapping="[254]")
        db.add(item)
        await db.flush()
        db.add(
            PrintQueueVariant(
                queue_item_id=item.id,
                position=0,
                library_file_id=lib.id,
                target_model="A1",
                ams_mapping="[1]",
            )
        )
        await db.commit()
        item_id = item.id

    await _run_check_queue(queue_db, PrintScheduler(), 3)

    item = await _get_item(queue_db, item_id)
    assert item.printer_id == 3
    assert item.ams_mapping == "[3]"
