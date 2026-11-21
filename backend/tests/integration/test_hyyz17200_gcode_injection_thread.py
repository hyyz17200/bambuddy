"""G-code injection runs in a worker thread, not on the event loop (hyyz17200).

Injecting into a large plate re-compresses tens of MB of G-code and takes
seconds; on the event loop that stalls MQTT, WebSocket and the API meanwhile.
"""

import json
import threading
from unittest.mock import patch

import pytest
from sqlalchemy import update

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services import print_scheduler
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401


@pytest.mark.asyncio
async def test_injection_runs_off_the_event_loop_and_its_file_is_uploaded(farm, tmp_path):  # noqa: F811
    printer_id = await farm.add_printer("A1-01")
    item_id = await farm.add_item(printer_id=printer_id)
    async with farm.session_maker() as db:
        await db.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(gcode_injection=True))
        db.add(Settings(key="gcode_snippets", value=json.dumps({"X1C": {"end_gcode": "M400"}})))
        await db.commit()

    injected = tmp_path / "injected.3mf"
    injected.write_bytes(b"injected payload")
    calls = []

    def fake_inject(source_path, plate_id, start_gcode, end_gcode):
        calls.append((threading.get_ident(), plate_id, start_gcode, end_gcode))
        return injected

    loop_thread = threading.get_ident()
    async with _scheduler(farm) as scheduler:
        with patch("backend.app.utils.threemf_tools.inject_gcode_into_3mf", fake_inject):
            await scheduler.check_queue()
            tasks = [task for (task, _pid) in scheduler._inflight.values()]
            for task in tasks:
                await task
        upload = print_scheduler.upload_file_async

    assert len(calls) == 1
    thread, plate_id, start_gcode, end_gcode = calls[0]
    assert thread != loop_thread
    assert (plate_id, start_gcode, end_gcode) == (1, None, "M400")
    assert upload.await_args.args[2] == injected
    assert (await farm.item(item_id)).status == "printing"
