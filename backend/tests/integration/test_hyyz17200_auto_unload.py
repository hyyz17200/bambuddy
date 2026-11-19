"""Auto unload: filament back into the AMS after a long idle (hyyz17200).

The printers are real BambuMQTTClients with the MQTT connection mocked out, so
the refreshed report goes through upstream's own parsing, and the unload is
upstream's own command.
"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.hyyz17200 import auto_unload, calibration_batch, hms_filter, printer_intake
from backend.app.hyyz17200.models import CalibrationBatch, CalibrationItem
from backend.app.services.bambu_mqtt import BambuMQTTClient

SETTINGS_URL = "/api/v1/hyyz17200/settings"


def _trays(types: list[str]) -> list[dict]:
    return [{"id": str(n), "tray_type": t, "tray_color": "FFFFFFFF"} for n, t in enumerate(types)]


def _report(tray_now: int, gcode_state: str = "FINISH", types=("PETG", "PETG", "PETG", "PLA")) -> dict:
    """A full push_status as a pushall answer: well over FULL_REPORT_KEYS fields."""
    report = {
        "command": "push_status",
        "gcode_state": gcode_state,
        "ams": {
            "ams": [{"id": "0", "info": "1001", "tray": _trays(list(types))}],
            "ams_exist_bits": "1",
            "tray_exist_bits": "f",
            "tray_now": str(tray_now),
            "tray_tar": "255",
            "tray_pre": "255",
            "ams_status": 0,
        },
    }
    for n in range(auto_unload.FULL_REPORT_KEYS):
        report[f"filler_{n}"] = n
    return {"print": report}


class Printer:
    """One printer: a real client whose MQTT publishes are captured."""

    def __init__(self, printer_id: int, tray_now: int = 2):
        self.id = printer_id
        self.client = BambuMQTTClient(
            ip_address=f"10.0.0.{printer_id}", serial_number=f"SN{printer_id:04d}", access_code="12345678"
        )
        self.client._client = MagicMock()
        self.client._client.publish.side_effect = self._on_publish
        self.client.state.connected = True
        self.client.state.state = "FINISH"
        self.client.state.tray_now = tray_now
        self.client.state.raw_data["ams"] = [
            {"id": "0", "info": "1001", "tray": _trays(["PETG", "PETG", "PETG", "PLA"])}
        ]
        # What the printer answers a pushall with; None stays silent.
        self.answer: dict | None = _report(tray_now)
        # Whether it carries the unload out.
        self.unloads = True
        self.sent: list[dict] = []

    @property
    def state(self):
        return self.client.state

    def _deliver(self, message: dict) -> None:
        self.client._on_message(
            None, None, SimpleNamespace(topic=self.client.topic_subscribe, payload=json.dumps(message).encode())
        )

    def _on_publish(self, topic, payload, qos=0):
        body = json.loads(payload)
        if body.get("pushing", {}).get("command") == "pushall":
            if self.answer is not None:
                self._deliver(self.answer)
            return
        command = body.get("print", {})
        self.sent.append(command)
        if command.get("command") == "ams_change_filament" and self.unloads:
            self.state.tray_now = 255

    @property
    def unload_commands(self) -> list[dict]:
        return [c for c in self.sent if c.get("command") == "ams_change_filament"]


class Manager:
    """Stands in for printer_manager."""

    def __init__(self):
        self.printers: dict[int, Printer] = {}
        self.drying: dict[int, dict] = {}

    def add(self, printer_id: int, **kwargs) -> Printer:
        printer = Printer(printer_id, **kwargs)
        self.printers[printer_id] = printer
        return printer

    def get_all_statuses(self):
        return {pid: p.state for pid, p in self.printers.items()}

    def get_client(self, printer_id):
        printer = self.printers.get(printer_id)
        return printer.client if printer else None

    def get_drying_targets(self, printer_id):
        return self.drying.get(printer_id)


@pytest.fixture
def farm(monkeypatch):
    manager = Manager()
    monkeypatch.setattr(auto_unload, "printer_manager", manager)
    monkeypatch.setattr(auto_unload, "REPORT_SETTLE_SECONDS", 0)
    monkeypatch.setattr(auto_unload, "REFRESH_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(auto_unload, "FOLLOW_SECONDS", 0.01)
    monkeypatch.setattr(auto_unload, "UNSEEN_UNLOAD_SECONDS", 0)
    monkeypatch.setattr(auto_unload, "UNLOAD_TIMEOUT_SECONDS", 0.2)

    async def no_batch(printer_id):
        return False

    monkeypatch.setattr(auto_unload, "_in_calibration_batch", no_batch)
    auto_unload.apply_settings(auto_unload.AutoUnloadSettings(enabled=True, idle_minutes=30))
    yield manager
    auto_unload.apply_settings(auto_unload.AutoUnloadSettings())
    auto_unload._tracks.clear()
    auto_unload._busy.clear()
    auto_unload._attempts.clear()
    hms_filter.set_hidden_codes([])


def _age(printer_id: int, minutes: float = 31) -> None:
    auto_unload._tracks[printer_id].since -= minutes * 60


async def _pass() -> None:
    """One pass, then wait for the unloads it started."""
    await auto_unload.tick()
    tasks = list(auto_unload._attempts.values())
    if tasks:
        await asyncio.gather(*tasks)


async def _idle_for(printer_id: int, minutes: float = 31) -> None:
    await _pass()  # first sight starts the clock
    _age(printer_id, minutes)
    await _pass()


class TestWhen:
    @pytest.mark.asyncio
    async def test_unloads_the_loaded_slot_after_the_idle_time(self, farm):
        printer = farm.add(1, tray_now=2)

        await _idle_for(1)

        [command] = printer.unload_commands
        # Upstream's unload, addressed to AMS 0 (slot 2 is ams 0); 210 for a cold nozzle,
        # as Bambu Studio's unload button sends for every material.
        assert (command["ams_id"], command["slot_id"], command["target"]) == (0, 255, 255)
        assert (command["curr_temp"], command["tar_temp"]) == (210, 210)
        assert printer.state.tray_now == 255
        assert not auto_unload.is_busy(1)

    @pytest.mark.asyncio
    async def test_not_before_the_idle_time(self, farm):
        printer = farm.add(1)

        await _idle_for(1, minutes=29)

        assert printer.unload_commands == []

    @pytest.mark.asyncio
    async def test_the_idle_time_is_the_setting(self, farm):
        printer = farm.add(1)
        auto_unload.apply_settings(auto_unload.AutoUnloadSettings(enabled=True, idle_minutes=60))

        await _idle_for(1, minutes=45)
        assert printer.unload_commands == []

        _age(1, 20)
        await _pass()
        assert len(printer.unload_commands) == 1

    @pytest.mark.asyncio
    async def test_any_change_starts_the_idle_time_over(self, farm):
        printer = farm.add(1, tray_now=2)
        await _pass()
        _age(1)

        printer.state.tray_now = 1
        printer.answer = _report(1)
        await _pass()
        assert printer.unload_commands == []

        _age(1)
        await _pass()
        assert printer.unload_commands[0]["ams_id"] == 0

    @pytest.mark.asyncio
    async def test_off_does_nothing(self, farm):
        printer = farm.add(1)
        auto_unload.apply_settings(auto_unload.AutoUnloadSettings(enabled=False))

        await _pass()
        assert auto_unload._tracks == {}
        await _pass()

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_once_per_idle_stretch(self, farm):
        printer = farm.add(1)
        printer.unloads = False  # it fails, and shows its own fault

        await _idle_for(1)
        _age(1, 120)
        await _pass()
        assert len(printer.unload_commands) == 1

        # It prints, and the stretch after is a new one.
        printer.state.state = "RUNNING"
        await _pass()
        printer.state.state = "FINISH"
        await _pass()
        _age(1)
        await _pass()
        assert len(printer.unload_commands) == 2


class TestWhatIsLeftAlone:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("tray_now", [254, 255])
    async def test_the_external_spool_and_nothing_loaded(self, farm, tray_now):
        printer = farm.add(1, tray_now=tray_now)
        printer.answer = _report(tray_now)

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_failed_print(self, farm):
        printer = farm.add(1)
        printer.state.state = "FAILED"

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_an_empty_slot(self, farm):
        printer = farm.add(1, tray_now=2)
        printer.state.raw_data["ams"][0]["tray"][2]["tray_type"] = ""

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_dual_nozzle_printer(self, farm):
        printer = farm.add(1)
        printer.client._is_dual_nozzle = True

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_busy_ams(self, farm):
        printer = farm.add(1)
        printer.state.ams_status_main = 2  # reading an RFID tag

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_drying_ams(self, farm):
        printer = farm.add(1)
        farm.drying[1] = {0: {"filament": "PETG", "temp": 65}}

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_fault_but_not_a_hidden_one(self, farm):
        printer = farm.add(1)
        printer.state.hms_errors = [SimpleNamespace(full_code="0700200000020001")]

        await _idle_for(1)
        assert printer.sent == []

        hms_filter.set_hidden_codes(["0700200000020001"])
        await _pass()
        assert len(printer.unload_commands) == 1

    @pytest.mark.asyncio
    async def test_a_queue_job_on_its_way(self, farm, monkeypatch):
        from backend.app.services.print_scheduler import scheduler

        printer = farm.add(1)
        monkeypatch.setattr(scheduler, "_inflight", {99: (MagicMock(), 1)})

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_bed_kept_warm_for_a_coming_job(self, farm, monkeypatch):
        from backend.app.services.print_scheduler import scheduler

        printer = farm.add(1)
        monkeypatch.setattr(scheduler, "_keep_warm", {1: object()})

        await _idle_for(1)

        assert printer.sent == []

    @pytest.mark.asyncio
    async def test_a_printer_in_a_calibration_batch(self, farm, monkeypatch):
        printer = farm.add(1)

        async def in_batch(printer_id):
            return True

        monkeypatch.setattr(auto_unload, "_in_calibration_batch", in_batch)
        await _idle_for(1)

        assert printer.sent == []
        # Not given up on: it goes once the batch is over.
        assert auto_unload._tracks[1].tried is False


class TestRefresh:
    @pytest.mark.asyncio
    async def test_a_full_report_is_asked_for_first(self, farm):
        printer = farm.add(1)
        pushalls = []
        printer.client.request_status_update = MagicMock(
            side_effect=lambda: pushalls.append(True) or printer._deliver(printer.answer) or True
        )

        await _idle_for(1)

        assert pushalls == [True]
        assert len(printer.unload_commands) == 1

    @pytest.mark.asyncio
    async def test_a_slot_changed_on_the_printer_is_not_unloaded(self, farm):
        """The partial reports had not caught up with the printer's screen."""
        printer = farm.add(1, tray_now=2)
        printer.answer = _report(3)

        await _idle_for(1)

        assert printer.unload_commands == []
        assert printer.state.tray_now == 3

    @pytest.mark.asyncio
    async def test_a_slot_emptied_on_the_printer_is_not_unloaded(self, farm):
        printer = farm.add(1, tray_now=2)
        printer.answer = _report(2, types=("PETG", "PETG", "", "PLA"))

        await _idle_for(1)

        assert printer.unload_commands == []

    @pytest.mark.asyncio
    async def test_a_partial_report_is_not_the_answer(self, farm):
        printer = farm.add(1)
        printer.answer = {"print": {"command": "push_status", "ams": {"tray_now": "2"}}}

        await _idle_for(1)

        assert printer.unload_commands == []

    @pytest.mark.asyncio
    async def test_no_answer_is_tried_three_times(self, farm):
        printer = farm.add(1)
        printer.answer = None

        await _idle_for(1)
        await _pass()
        await _pass()
        await _pass()

        assert auto_unload._tracks[1].refresh_failures == auto_unload.REFRESH_TRIES
        assert printer.unload_commands == []
        assert printer.client._raw_message_handlers == []


class TestBusy:
    @pytest.mark.asyncio
    async def test_busy_from_the_refresh_until_unloaded(self, farm, monkeypatch):
        printer = farm.add(1)
        printer.unloads = False
        monkeypatch.setattr(auto_unload, "UNLOAD_TIMEOUT_SECONDS", 30)
        seen_busy = []
        printer.client.request_status_update = MagicMock(
            side_effect=lambda: seen_busy.append(auto_unload.is_busy(1)) or printer._deliver(printer.answer) or True
        )
        await _pass()
        _age(1)

        await auto_unload.tick()
        await asyncio.sleep(0.05)
        assert seen_busy == [True]
        assert auto_unload.busy_printer_ids() == {1}

        printer.state.tray_now = 255
        await asyncio.gather(*auto_unload._attempts.values())
        assert auto_unload.busy_printer_ids() == set()

    @pytest.mark.asyncio
    async def test_gives_up_after_the_timeout(self, farm, monkeypatch, caplog):
        printer = farm.add(1)
        printer.unloads = False
        monkeypatch.setattr(auto_unload, "UNLOAD_TIMEOUT_SECONDS", 0.05)

        await _idle_for(1)

        assert not auto_unload.is_busy(1)
        assert "not unloaded after" in caplog.text

    @pytest.mark.asyncio
    async def test_the_queue_skips_it_and_says_why(self, farm, db_session, printer_factory):
        printer = await printer_factory(name="A1-07")
        auto_unload._busy[printer.id] = 0.0

        assert await printer_intake.queue_skipped_printer_ids(db_session) == {printer.id}
        assert await printer_intake.stopped_printer_ids(db_session) == set()
        assert printer_intake.waiting_reason("A1-07", printer.id) == "Busy: A1-07 (unloading filament)"
        assert printer_intake.waiting_reason("A1-07") == "Busy: A1-07 (not taking jobs)"

    def test_the_calibration_batch_waits_for_it(self, farm, monkeypatch):
        state = SimpleNamespace(state="FINISH")
        monkeypatch.setattr(
            calibration_batch,
            "printer_manager",
            SimpleNamespace(
                get_status=lambda pid: state, is_connected=lambda pid: True, is_awaiting_plate_clear=lambda pid: False
            ),
        )
        printer = SimpleNamespace(id=5, is_active=True)

        assert calibration_batch._blocker(printer, False) is None
        auto_unload._busy[5] = 0.0
        assert calibration_batch._blocker(printer, False) == "busy"


class TestCalibrationBatchCheck:
    @pytest.mark.asyncio
    async def test_only_an_open_item_of_a_running_batch(self, db_session, test_engine, printer_factory, monkeypatch):
        monkeypatch.setattr(
            auto_unload.database,
            "async_session",
            async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False),
        )
        printer = await printer_factory()
        batch = CalibrationBatch(status="running", bed_leveling=True, vibration=True, motor_noise=False)
        db_session.add(batch)
        await db_session.flush()
        item = CalibrationItem(batch_id=batch.id, printer_id=printer.id, position=0, status="waiting")
        db_session.add(item)
        await db_session.commit()

        assert await auto_unload._in_calibration_batch(printer.id) is True

        item.status = "succeeded"
        await db_session.commit()
        assert await auto_unload._in_calibration_batch(printer.id) is False


class TestSettings:
    @pytest.mark.asyncio
    async def test_defaults_off_30_minutes(self, async_client: AsyncClient):
        body = (await async_client.get(SETTINGS_URL)).json()
        assert body["auto_unload"] == {"enabled": False, "idle_minutes": 30}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("minutes", [4, 721])
    async def test_out_of_range_is_refused(self, async_client: AsyncClient, minutes):
        response = await async_client.put(
            f"{SETTINGS_URL}/auto_unload", json={"enabled": True, "idle_minutes": minutes}
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_saving_takes_effect(self, async_client: AsyncClient):
        try:
            response = await async_client.put(f"{SETTINGS_URL}/auto_unload", json={"enabled": True, "idle_minutes": 90})
            assert response.status_code == 200
            assert auto_unload._settings == auto_unload.AutoUnloadSettings(enabled=True, idle_minutes=90)
        finally:
            auto_unload.apply_settings(auto_unload.AutoUnloadSettings())


class TestUpstreamContracts:
    def test_the_scheduler_keeps_its_bookkeeping(self):
        from backend.app.services.print_scheduler import scheduler

        assert isinstance(scheduler._keep_warm, dict)
        assert isinstance(scheduler._inflight, dict)

    def test_the_client_says_whether_it_has_two_nozzles(self):
        client = BambuMQTTClient(ip_address="10.0.0.1", serial_number="SN", access_code="12345678")
        assert client._is_dual_nozzle is False

    def test_the_scheduler_asks_the_fork_for_both(self):
        """print_scheduler's hook calls queue_skipped_printer_ids and passes the id
        to waiting_reason; a rebase that drops either loses the hold."""
        import inspect

        from backend.app.services import print_scheduler

        source = inspect.getsource(print_scheduler.PrintScheduler.check_queue)
        assert "hyyz17200_intake.queue_skipped_printer_ids(db)" in source
        assert "hyyz17200_intake.waiting_reason(printer_label(stopped_pid), stopped_pid)" in source

    def test_the_fork_runs_the_loop_in_the_lifespan(self):
        import inspect

        from backend.app import hyyz17200

        source = inspect.getsource(hyyz17200._wrap_lifespan)
        assert "auto_unload.runner.start()" in source
        assert "auto_unload.runner.stop()" in source
