"""A print whose injected End G-code swapped the plate skips the plate-clear check (hyyz17200)."""

import json
import zipfile
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select, update

from backend.app.hyyz17200 import plate_swap
from backend.app.hyyz17200.models import PlateSwapDispatch
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services import print_dispatch_context

# Same in-memory farm and mocked printers as the stop-taking-jobs tests.
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401

SWAP_GCODE = "M400 ; eject plate"


def _completion(status: str = "completed", subtask_name: str = "job-0", filename: str = "/data/Metadata/plate_1.gcode"):
    return {"status": status, "subtask_name": subtask_name, "filename": filename}


async def _set_status(ctx, item_id: int, status: str) -> None:
    async with ctx.session_maker() as db:
        await db.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(status=status))
        await db.commit()


async def _rows(ctx) -> set[int]:
    async with ctx.session_maker() as db:
        return set((await db.execute(select(PlateSwapDispatch.queue_item_id))).scalars().all())


async def _record(ctx, item_id: int, injected: bool) -> None:
    async with ctx.session_maker() as db:
        await plate_swap.record_dispatch(db, item_id, injected)
        await db.commit()


async def _swapped(ctx, printer_id: int, data: dict) -> bool:
    return await plate_swap.plate_swapped_away(printer_id, data, ctx.session_maker)


async def _printing_job(ctx, *, injected: bool = True) -> tuple[int, int]:
    """A printer with one job printing, sent as job-0.3mf."""
    printer_id = await ctx.add_printer("A1-01")
    item_id = await ctx.add_item(printer_id=printer_id)
    await _record(ctx, item_id, injected)
    await _set_status(ctx, item_id, "printing")
    return printer_id, item_id


class TestCompletion:
    @pytest.mark.asyncio
    async def test_a_swapped_print_needs_no_click(self, farm):  # noqa: F811
        printer_id, _ = await _printing_job(farm)

        assert await _swapped(farm, printer_id, _completion()) is True

    @pytest.mark.asyncio
    async def test_it_survives_a_restart(self, farm):  # noqa: F811
        """Upstream's in-memory flag is gone after a restart; the table is not."""
        printer_id, _ = await _printing_job(farm)
        print_dispatch_context.clear(printer_id)

        assert await _swapped(farm, printer_id, _completion()) is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["failed", "aborted", "cancelled"])
    async def test_an_unfinished_print_never_reached_the_swap(self, farm, status):  # noqa: F811
        printer_id, _ = await _printing_job(farm)

        assert await _swapped(farm, printer_id, _completion(status)) is False

    @pytest.mark.asyncio
    async def test_a_job_sent_without_end_gcode(self, farm):  # noqa: F811
        printer_id, _ = await _printing_job(farm, injected=False)

        assert await _swapped(farm, printer_id, _completion()) is False

    @pytest.mark.asyncio
    async def test_another_file_finished(self, farm):  # noqa: F811
        """A print started from the slicer while the job row still says printing."""
        printer_id, _ = await _printing_job(farm)

        assert await _swapped(farm, printer_id, _completion(subtask_name="something-else")) is False

    @pytest.mark.asyncio
    async def test_an_unnamed_completion_is_not_trusted(self, farm):  # noqa: F811
        printer_id, _ = await _printing_job(farm)

        assert await _swapped(farm, printer_id, _completion(subtask_name="", filename="")) is False

    @pytest.mark.asyncio
    async def test_a_completion_rebuilt_at_reconnect(self, farm):  # noqa: F811
        """Finished while Bambuddy was down: the synthesised completion carries
        the archive's file name, and a print name that need not match."""
        printer_id, _ = await _printing_job(farm)

        data = _completion(subtask_name="Display Name", filename="job-0.3mf")
        assert await _swapped(farm, printer_id, data) is True

    @pytest.mark.asyncio
    async def test_no_job_printing(self, farm):  # noqa: F811
        printer_id, item_id = await _printing_job(farm)
        await _set_status(farm, item_id, "completed")

        assert await _swapped(farm, printer_id, _completion()) is False

    @pytest.mark.asyncio
    async def test_two_jobs_printing_is_ambiguous(self, farm):  # noqa: F811
        printer_id, _ = await _printing_job(farm)
        other = await farm.add_item(printer_id=printer_id, position=1)
        await _set_status(farm, other, "printing")

        assert await _swapped(farm, printer_id, _completion()) is False

    @pytest.mark.asyncio
    async def test_an_error_keeps_the_check(self):
        broken = MagicMock(side_effect=RuntimeError("database is locked"))

        assert await plate_swap.plate_swapped_away(1, _completion(), broken) is False


class TestRecord:
    @pytest.mark.asyncio
    async def test_a_resend_without_end_gcode_drops_the_row(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        await _record(farm, item_id, True)
        await _record(farm, item_id, False)

        assert await _rows(farm) == set()

    @pytest.mark.asyncio
    async def test_rows_of_finished_jobs_are_pruned(self, farm):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        done = await farm.add_item(printer_id=printer_id)
        await _record(farm, done, True)
        await _set_status(farm, done, "completed")
        nxt = await farm.add_item(printer_id=printer_id, position=1)

        await _record(farm, nxt, True)

        assert await _rows(farm) == {nxt}


def _real_3mf(path) -> None:
    gcode = "; HEADER_BLOCK_START\n; HEADER_BLOCK_END\nG28\n; EXECUTABLE_BLOCK_END\n"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/plate_1.gcode", gcode)


class TestDispatch:
    """The scheduler records only the End G-code that really went out."""

    @staticmethod
    async def _injecting_job(ctx, *, valid_3mf: bool) -> int:
        printer_id = await ctx.add_printer("A1-01")
        item_id = await ctx.add_item(printer_id=printer_id)
        if valid_3mf:
            _real_3mf(ctx.base_dir / "archives" / "job-0.3mf")
        async with ctx.session_maker() as db:
            await db.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(gcode_injection=True))
            db.add(Settings(key="gcode_snippets", value=json.dumps({"X1C": {"end_gcode": SWAP_GCODE}})))
            await db.commit()
        return item_id

    @pytest.mark.asyncio
    async def test_injected_end_gcode_is_recorded(self, farm):  # noqa: F811
        item_id = await self._injecting_job(farm, valid_3mf=True)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        assert (await farm.item(item_id)).status == "printing"
        assert await _rows(farm) == {item_id}

    @pytest.mark.asyncio
    async def test_a_failed_injection_is_not(self, farm):  # noqa: F811
        """Upstream sends the original file when injection fails; it has no swap."""
        item_id = await self._injecting_job(farm, valid_3mf=False)

        async with _scheduler(farm) as scheduler:
            await scheduler.check_queue()

        assert (await farm.item(item_id)).status == "printing"
        assert await _rows(farm) == set()

    @pytest.mark.asyncio
    async def test_a_recording_failure_does_not_stop_the_print(self, farm):  # noqa: F811
        item_id = await self._injecting_job(farm, valid_3mf=True)

        with patch.object(plate_swap, "PlateSwapDispatch", side_effect=RuntimeError("boom")):
            async with _scheduler(farm) as scheduler:
                await scheduler.check_queue()

        assert (await farm.item(item_id)).status == "printing"
        assert await _rows(farm) == set()
