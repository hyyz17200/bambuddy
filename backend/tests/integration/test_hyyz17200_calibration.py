"""Batch calibration: one printer at a time, only bits 1-3 (hyyz17200)."""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.hyyz17200 import calibration_batch, calibration_support, plate_swap, printer_intake
from backend.app.hyyz17200.models import CalibrationBatch, CalibrationItem, PrinterIntakeStop
from backend.app.models.settings import Settings

BATCH_URL = "/api/v1/hyyz17200/calibration/batch"
PREVIEW_URL = "/api/v1/hyyz17200/calibration/preview"
CANCEL_URL = "/api/v1/hyyz17200/calibration/batch/cancel"
CALIBRATION = "auto_cali_for_user_param"


class FakeClient:
    def __init__(self):
        self.calls: list[dict] = []
        self.handlers = []

    def start_calibration(self, **kwargs) -> bool:
        self.calls.append(kwargs)
        return True

    def register_raw_message_handler(self, handler):
        self.handlers.append(handler)

    def unregister_raw_message_handler(self, handler):
        self.handlers.remove(handler)


class Farm:
    """Stands in for printer_manager: per-printer state the test moves along."""

    def __init__(self):
        self.states: dict[int, SimpleNamespace] = {}
        self.connected: set[int] = set()
        self.clients: dict[int, FakeClient] = {}
        self.plate: set[int] = set()
        self.support: dict[int, bool | None] = {}
        self.clock = datetime(2026, 11, 3, 12, 0, 0)

    def add(self, printer_id: int, state: str = "FINISH") -> None:
        self.states[printer_id] = SimpleNamespace(state=state, gcode_file="old.gcode", subtask_name="old", stg_cur=-1)
        self.connected.add(printer_id)
        self.clients[printer_id] = FakeClient()

    def report(self, printer_id: int, state: str, name: str | None = CALIBRATION, stg_cur: int = -1) -> None:
        current = self.states[printer_id]
        current.state = state
        if name is not None:
            current.gcode_file = name
            current.subtask_name = name
        current.stg_cur = stg_cur

    def advance(self, seconds: float) -> None:
        self.clock += timedelta(seconds=seconds)

    # printer_manager's interface
    def get_status(self, printer_id):
        return self.states.get(printer_id)

    def is_connected(self, printer_id):
        return printer_id in self.connected

    def get_client(self, printer_id):
        return self.clients.get(printer_id)

    def is_awaiting_plate_clear(self, printer_id):
        return printer_id in self.plate

    def request_status_update(self, printer_id):
        return True


@pytest.fixture
def farm(monkeypatch):
    farm = Farm()
    monkeypatch.setattr(calibration_batch, "printer_manager", farm)
    monkeypatch.setattr(calibration_support, "printer_manager", farm)

    async def probe(printer_ids, wait=0):
        return {pid: farm.support.get(pid, False) for pid in printer_ids}

    monkeypatch.setattr(calibration_support, "probe", probe)
    monkeypatch.setattr(calibration_batch, "utcnow_naive", lambda: farm.clock)
    monkeypatch.setattr(calibration_batch.runner, "ensure_running", lambda: None)
    yield farm
    calibration_support._watches.clear()
    calibration_batch._observed.clear()


async def _printers(printer_factory, farm: Farm, count: int, state: str = "FINISH") -> list[int]:
    ids = []
    for n in range(count):
        printer = await printer_factory(name=f"A1-{n + 1:02d}", model="A1")
        farm.add(printer.id, state)
        ids.append(printer.id)
    return ids


async def _start(db: AsyncSession, ids: list[int], **options) -> CalibrationBatch:
    values = {"bed_leveling": True, "vibration": True, "motor_noise": True, "resume_intake": True} | options
    return await calibration_batch.create_batch(db, ids, by="tester", **values)


async def _items(db: AsyncSession) -> dict[int, CalibrationItem]:
    db.expire_all()
    rows = (await db.execute(select(CalibrationItem))).scalars().all()
    return {item.printer_id: item for item in rows}


async def _set(db: AsyncSession, key: str, value: str) -> None:
    db.add(Settings(key=key, value=value))
    await db.commit()


async def _calibrate(db: AsyncSession, farm: Farm, printer_id: int, end: str = "FINISH") -> None:
    """From the command to the end, with the passes the runner would make."""
    await calibration_batch.tick(db)
    farm.report(printer_id, "RUNNING", stg_cur=13)
    await calibration_batch.tick(db)
    farm.report(printer_id, "RUNNING", stg_cur=3)
    await calibration_batch.tick(db)
    farm.report(printer_id, end, stg_cur=-1)
    await calibration_batch.tick(db)


class TestBits:
    @pytest.mark.asyncio
    async def test_motor_noise_left_out_unless_the_printer_reports_it(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])

        await calibration_batch.tick(db_session)

        assert farm.clients[pid].calls == [{"bed_leveling": True, "vibration": True, "motor_noise": False}]
        item = (await _items(db_session))[pid]
        assert (item.status, item.option, item.motor_noise_skipped) == ("starting", 6, True)

    @pytest.mark.asyncio
    async def test_motor_noise_sent_when_reported(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        farm.support[pid] = True
        await _start(db_session, [pid])

        await calibration_batch.tick(db_session)

        assert farm.clients[pid].calls == [{"bed_leveling": True, "vibration": True, "motor_noise": True}]
        assert (await _items(db_session))[pid].option == 14

    @pytest.mark.asyncio
    async def test_unknown_report_is_not_support(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        farm.support[pid] = None
        await _start(db_session, [pid], bed_leveling=False)

        await calibration_batch.tick(db_session)

        assert farm.clients[pid].calls == [{"bed_leveling": False, "vibration": True, "motor_noise": False}]

    @pytest.mark.asyncio
    async def test_nothing_left_to_run_is_skipped(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        farm.support[b] = True
        await _start(db_session, [a, b], bed_leveling=False, vibration=False)

        await calibration_batch.tick(db_session)

        items = await _items(db_session)
        assert (items[a].status, items[a].detail) == ("skipped", "motor_noise_unsupported")
        assert farm.clients[a].calls == []
        # No command went out, so no settle: the next printer starts at once.
        assert farm.clients[b].calls == [{"bed_leveling": False, "vibration": False, "motor_noise": True}]

    @pytest.mark.asyncio
    async def test_nothing_selected_is_refused(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        with pytest.raises(calibration_batch.BatchError) as raised:
            await _start(db_session, [pid], bed_leveling=False, vibration=False, motor_noise=False)
        assert raised.value.code == "nothing_selected"


class TestOneAtATime:
    @pytest.mark.asyncio
    async def test_the_next_starts_only_after_the_last_is_idle_and_settled(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])

        await calibration_batch.tick(db_session)
        assert len(farm.clients[a].calls) == 1
        # A stale FINISH from the last print is not the end of this one.
        farm.advance(10)
        await calibration_batch.tick(db_session)
        assert (await _items(db_session))[a].status == "starting"

        farm.report(a, "PREPARE")
        await calibration_batch.tick(db_session)
        farm.report(a, "RUNNING", stg_cur=3)
        farm.advance(600)
        await calibration_batch.tick(db_session)
        items = await _items(db_session)
        assert items[a].status == "running"
        assert items[b].status == "waiting"
        assert farm.clients[b].calls == []

        farm.report(a, "FINISH")
        await calibration_batch.tick(db_session)
        assert (await _items(db_session))[a].status == "succeeded"
        assert farm.clients[b].calls == []  # settling

        farm.advance(calibration_batch.SETTLE_SECONDS - 1)
        await calibration_batch.tick(db_session)
        assert farm.clients[b].calls == []
        farm.advance(2)
        await calibration_batch.tick(db_session)
        assert len(farm.clients[b].calls) == 1

        farm.report(b, "RUNNING")
        await calibration_batch.tick(db_session)
        farm.report(b, "FINISH")
        await calibration_batch.tick(db_session)
        farm.advance(calibration_batch.SETTLE_SECONDS)
        assert await calibration_batch.tick(db_session) is False

        batch = await db_session.scalar(select(CalibrationBatch))
        await db_session.refresh(batch)
        assert batch.status == "finished"
        assert (await _items(db_session))[a].stages == "3"

    @pytest.mark.asyncio
    async def test_a_printer_that_is_not_ready_is_passed_over(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        farm.report(a, "RUNNING", name="someone_else.3mf")
        await _start(db_session, [a, b])

        await calibration_batch.tick(db_session)

        assert farm.clients[a].calls == []
        assert len(farm.clients[b].calls) == 1

    @pytest.mark.asyncio
    async def test_an_unrecognised_job_is_waited_out(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])
        await calibration_batch.tick(db_session)

        farm.report(a, "RUNNING", name="benchy.3mf")
        await calibration_batch.tick(db_session)
        farm.advance(7200)
        await calibration_batch.tick(db_session)
        assert farm.clients[b].calls == []

        farm.report(a, "FINISH", name="benchy.3mf")
        await calibration_batch.tick(db_session)
        item = (await _items(db_session))[a]
        assert (item.status, item.detail) == ("failed", "unrecognized")

    @pytest.mark.asyncio
    async def test_an_offline_printer_is_waited_for(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])
        await calibration_batch.tick(db_session)
        farm.report(a, "RUNNING")
        await calibration_batch.tick(db_session)

        farm.connected.discard(a)
        farm.advance(3 * 3600)
        await calibration_batch.tick(db_session)
        assert (await _items(db_session))[a].status == "running"
        assert farm.clients[b].calls == []

        farm.connected.add(a)
        farm.report(a, "FINISH")
        await calibration_batch.tick(db_session)
        assert (await _items(db_session))[a].status == "succeeded"

    @pytest.mark.asyncio
    async def test_a_printer_that_never_leaves_idle_did_not_start(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        await calibration_batch.tick(db_session)

        farm.advance(calibration_batch.START_TIMEOUT_SECONDS - 1)
        await calibration_batch.tick(db_session)
        assert (await _items(db_session))[pid].status == "starting"
        farm.advance(2)
        await calibration_batch.tick(db_session)
        item = (await _items(db_session))[pid]
        assert (item.status, item.detail) == ("failed", "not_started")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("end", "detail"), [("FAILED", "printer_failed"), ("IDLE", "no_result")])
    async def test_other_endings_fail(self, db_session, printer_factory, farm, end, detail):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        await _calibrate(db_session, farm, pid, end=end)

        item = (await _items(db_session))[pid]
        assert (item.status, item.detail) == ("failed", detail)
        assert await printer_intake.stopped_printer_ids(db_session) == {pid}

    @pytest.mark.asyncio
    async def test_plate_clear_holds_only_with_the_switch_on(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        farm.plate.add(pid)
        await _start(db_session, [pid])

        await _set(db_session, "require_plate_clear", "true")
        await calibration_batch.tick(db_session)
        assert farm.clients[pid].calls == []

        setting = await db_session.scalar(select(Settings).where(Settings.key == "require_plate_clear"))
        setting.value = "false"
        await db_session.commit()
        await calibration_batch.tick(db_session)
        assert len(farm.clients[pid].calls) == 1

    @pytest.mark.asyncio
    async def test_the_kill_switch_holds_the_next_start(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        await _set(db_session, "billing_enabled", "true")
        await _set(db_session, "printer_kill_switch_enabled", "true")

        assert await calibration_batch.tick(db_session) is True
        assert farm.clients[pid].calls == []

    @pytest.mark.asyncio
    async def test_the_kill_switch_refuses_a_batch(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _set(db_session, "billing_enabled", "true")
        await _set(db_session, "printer_kill_switch_enabled", "true")

        with pytest.raises(calibration_batch.BatchError) as raised:
            await _start(db_session, [pid])
        assert raised.value.code == "kill_switch"

    @pytest.mark.asyncio
    async def test_one_batch_at_a_time(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        with pytest.raises(calibration_batch.BatchError) as raised:
            await _start(db_session, [pid])
        assert raised.value.code == "batch_running"


class TestTakingJobs:
    @pytest.mark.asyncio
    async def test_the_batch_stops_its_printers_and_success_resumes_them(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])
        assert await printer_intake.stopped_printer_ids(db_session) == {a, b}

        await _calibrate(db_session, farm, a)

        assert await printer_intake.stopped_printer_ids(db_session) == {b}

    @pytest.mark.asyncio
    async def test_a_printer_stopped_before_stays_stopped(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await printer_intake.set_stopped(db_session, pid, True, "someone")
        await _start(db_session, [pid])

        await _calibrate(db_session, farm, pid)

        assert (await _items(db_session))[pid].status == "succeeded"
        stop = await db_session.get(PrinterIntakeStop, pid)
        assert stop is not None and stop.stopped_by == "someone"

    @pytest.mark.asyncio
    async def test_resume_can_be_turned_off(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid], resume_intake=False)

        await _calibrate(db_session, farm, pid)

        assert await printer_intake.stopped_printer_ids(db_session) == {pid}

    @pytest.mark.asyncio
    async def test_resuming_a_waiting_printer_takes_it_out(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])
        await calibration_batch.tick(db_session)
        await printer_intake.set_stopped(db_session, b, False, None)
        farm.report(a, "RUNNING")
        await calibration_batch.tick(db_session)
        farm.report(a, "FINISH")
        await calibration_batch.tick(db_session)
        farm.advance(calibration_batch.SETTLE_SECONDS)

        await calibration_batch.tick(db_session)

        item = (await _items(db_session))[b]
        assert (item.status, item.detail) == ("cancelled", "intake_resumed")
        assert farm.clients[b].calls == []

    @pytest.mark.asyncio
    async def test_cancel_leaves_printers_stopped(self, db_session, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        await _start(db_session, [a, b])
        await calibration_batch.tick(db_session)

        assert await calibration_batch.cancel_batch(db_session) is True

        items = await _items(db_session)
        assert {i.status for i in items.values()} == {"cancelled"}
        assert await calibration_batch.tick(db_session) is False
        assert await printer_intake.stopped_printer_ids(db_session) == {a, b}
        assert await calibration_batch.cancel_batch(db_session) is False

    @pytest.mark.asyncio
    async def test_a_new_batch_replaces_the_old_results(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        await calibration_batch.cancel_batch(db_session)
        await _start(db_session, [pid])

        assert len((await db_session.execute(select(CalibrationBatch))).scalars().all()) == 1
        assert len((await db_session.execute(select(CalibrationItem))).scalars().all()) == 1

    @pytest.mark.asyncio
    async def test_deleting_the_printer_drops_its_row(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        printer = await db_session.get(calibration_batch.Printer, pid)

        await db_session.delete(printer)
        await db_session.commit()

        assert (await db_session.execute(select(CalibrationItem))).scalars().all() == []


class TestPlateClear:
    async def _running(self, db_session, printer_factory, farm) -> int:
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        await calibration_batch.tick(db_session)
        farm.report(pid, "RUNNING")
        await calibration_batch.tick(db_session)
        return pid

    @pytest.mark.asyncio
    async def test_a_batch_calibration_completing_skips_the_check(self, db_session, printer_factory, farm):
        pid = await self._running(db_session, printer_factory, farm)
        data = {"status": "completed", "filename": CALIBRATION, "subtask_name": CALIBRATION}

        assert await calibration_batch.skips_plate_clear(db_session, pid, data) is True
        # With no name at all, the job seen running decides.
        assert await calibration_batch.skips_plate_clear(db_session, pid, {"status": "completed"}) is True

    @pytest.mark.asyncio
    async def test_only_shortly_after_the_batch_marked_it_done(self, db_session, printer_factory, farm):
        pid = await self._running(db_session, printer_factory, farm)
        farm.report(pid, "FINISH")
        await calibration_batch.tick(db_session)
        data = {"status": "completed", "subtask_name": CALIBRATION}

        assert await calibration_batch.skips_plate_clear(db_session, pid, data) is True
        farm.advance(calibration_batch.PLATE_CLEAR_GRACE_SECONDS + 1)
        assert await calibration_batch.skips_plate_clear(db_session, pid, data) is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "data",
        [
            {"status": "failed", "subtask_name": CALIBRATION},
            {"status": "cancelled", "subtask_name": CALIBRATION},
            {"status": "completed", "subtask_name": "benchy"},
        ],
    )
    async def test_anything_else_keeps_the_check(self, db_session, printer_factory, farm, data):
        pid = await self._running(db_session, printer_factory, farm)
        assert await calibration_batch.skips_plate_clear(db_session, pid, data) is False

    @pytest.mark.asyncio
    async def test_a_calibration_outside_a_batch_keeps_the_check(self, db_session, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)
        data = {"status": "completed", "subtask_name": CALIBRATION}
        assert await calibration_batch.skips_plate_clear(db_session, pid, data) is False

    @pytest.mark.asyncio
    async def test_through_main_pys_hook(self, db_session, test_engine, printer_factory, farm):
        pid = await self._running(db_session, printer_factory, farm)
        session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
        data = {"status": "completed", "subtask_name": CALIBRATION}

        assert await plate_swap.plate_swapped_away(pid, data, session_factory) is True


class TestRestart:
    @pytest.mark.asyncio
    async def test_a_running_batch_is_picked_up(self, db_session, test_engine, printer_factory, farm, monkeypatch):
        (pid,) = await _printers(printer_factory, farm, 1)
        await _start(db_session, [pid])
        started = MagicMock()
        monkeypatch.setattr(calibration_batch.runner, "ensure_running", started)
        monkeypatch.setattr(
            calibration_batch.database,
            "async_session",
            async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False),
        )

        await calibration_batch.resume_at_startup()

        started.assert_called_once()
        assert pid in calibration_support._watches

    @pytest.mark.asyncio
    async def test_nothing_to_pick_up(self, test_engine, farm, monkeypatch):
        started = MagicMock()
        monkeypatch.setattr(calibration_batch.runner, "ensure_running", started)
        monkeypatch.setattr(
            calibration_batch.database,
            "async_session",
            async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False),
        )

        await calibration_batch.resume_at_startup()

        started.assert_not_called()


class TestPrinterReports:
    def _watch(self, monkeypatch) -> tuple[calibration_support._Watch, FakeClient]:
        client = FakeClient()
        manager = SimpleNamespace(get_client=lambda _pid: client)
        monkeypatch.setattr(calibration_support, "printer_manager", manager)
        assert calibration_support.watch(7) is True
        return calibration_support._watches[7], client

    def _send(self, client: FakeClient, payload: dict, topic: str = "device/SN/report") -> None:
        for handler in client.handlers:
            handler(topic, json.dumps(payload).encode())

    def teardown_method(self):
        calibration_support._watches.clear()

    def test_bit_21_of_home_flag(self, monkeypatch):
        _entry, client = self._watch(monkeypatch)
        assert calibration_support.motor_noise_supported(7) is None

        self._send(client, {"print": {"home_flag": 0x00000100}})
        assert calibration_support.motor_noise_supported(7) is False

        self._send(client, {"print": {"home_flag": 0x00200100}})
        assert calibration_support.motor_noise_supported(7) is True
        # Latched: a heartbeat without the bit does not take it back.
        self._send(client, {"print": {"home_flag": 0}})
        assert calibration_support.motor_noise_supported(7) is True

    def test_a_negative_home_flag(self, monkeypatch):
        _entry, client = self._watch(monkeypatch)
        self._send(client, {"print": {"home_flag": -(2**31) | (1 << 21)}})
        assert calibration_support.motor_noise_supported(7) is True

    @pytest.mark.parametrize("where", ["print", "top"])
    def test_bit_10_of_fun(self, monkeypatch, where):
        _entry, client = self._watch(monkeypatch)
        fun = format(1 << 10, "X")
        self._send(client, {"print": {"fun": fun}} if where == "print" else {"fun": fun, "print": {}})
        assert calibration_support.motor_noise_supported(7) is True

    def test_commands_to_the_printer_are_not_reports(self, monkeypatch):
        _entry, client = self._watch(monkeypatch)
        self._send(client, {"print": {"home_flag": 1 << 21}}, topic="device/SN/request")
        assert calibration_support.motor_noise_supported(7) is None

    def test_a_new_client_starts_over(self, monkeypatch):
        _entry, client = self._watch(monkeypatch)
        self._send(client, {"print": {"home_flag": 1 << 21, "mc_print_stage": "2"}})
        assert calibration_support.mc_print_stage(7) == "2"

        other = FakeClient()
        monkeypatch.setattr(calibration_support, "printer_manager", SimpleNamespace(get_client=lambda _pid: other))
        assert calibration_support.motor_noise_supported(7) is None
        assert calibration_support.watch(7) is True
        assert client.handlers == []
        assert len(other.handlers) == 1


class TestUpstreamContracts:
    def test_the_scheduler_bookkeeping_read_for_sends_in_flight(self):
        from backend.app.services.print_scheduler import scheduler

        assert isinstance(scheduler._inflight, dict)
        assert scheduler._printer_in_dispatch_hold(987654) is False

    @pytest.mark.parametrize(
        ("kwargs", "option"),
        [
            ({"bed_leveling": True, "vibration": True, "motor_noise": False}, 6),
            ({"bed_leveling": True, "vibration": True, "motor_noise": True}, 14),
            ({"bed_leveling": False, "vibration": True, "motor_noise": False}, 4),
        ],
    )
    def test_upstreams_command_carries_exactly_these_bits(self, kwargs, option):
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        client = BambuMQTTClient(ip_address="192.168.1.100", serial_number="TEST123", access_code="12345678")
        client._client = MagicMock()
        client.state.connected = True

        assert client.start_calibration(**kwargs) is True

        payload = json.loads(client._client.publish.call_args.args[1])
        assert payload["print"]["command"] == "calibration"
        assert payload["print"]["option"] == option


class TestApi:
    @pytest.mark.asyncio
    async def test_start_read_and_cancel(self, async_client: AsyncClient, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)

        response = await async_client.post(BATCH_URL, json={"printer_ids": [b, a], "motor_noise": False})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "running"
        assert body["motor_noise"] is False and body["resume_intake"] is True
        assert [(i["printer_id"], i["status"]) for i in body["items"]] == [(b, "waiting"), (a, "waiting")]

        stops = (await async_client.get("/api/v1/hyyz17200/printers/intake-stops")).json()
        assert {s["printer_id"] for s in stops} == {a, b}

        again = await async_client.post(BATCH_URL, json={"printer_ids": [a]})
        assert (again.status_code, again.json()["detail"]) == (409, "batch_running")

        assert (await async_client.post(CANCEL_URL)).status_code == 200
        read = (await async_client.get(BATCH_URL)).json()
        assert read["status"] == "cancelled"
        assert {i["status"] for i in read["items"]} == {"cancelled"}
        assert (await async_client.post(CANCEL_URL)).status_code == 404

    @pytest.mark.asyncio
    async def test_no_batch_yet(self, async_client: AsyncClient):
        response = await async_client.get(BATCH_URL)
        assert response.status_code == 200
        assert response.json() is None

    @pytest.mark.asyncio
    async def test_refusals(self, async_client: AsyncClient, printer_factory, farm):
        (pid,) = await _printers(printer_factory, farm, 1)

        unknown = await async_client.post(BATCH_URL, json={"printer_ids": [pid, 9999]})
        assert unknown.status_code == 404
        nothing = await async_client.post(
            BATCH_URL, json={"printer_ids": [pid], "bed_leveling": False, "vibration": False, "motor_noise": False}
        )
        assert (nothing.status_code, nothing.json()["detail"]) == (400, "nothing_selected")
        empty = await async_client.post(BATCH_URL, json={"printer_ids": []})
        assert empty.status_code == 422

    @pytest.mark.asyncio
    async def test_preview(self, async_client: AsyncClient, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        farm.support[a] = True
        farm.connected.discard(b)

        response = await async_client.post(PREVIEW_URL, json={"printer_ids": [a, b]})

        assert response.status_code == 200
        body = response.json()
        assert body["kill_switch"] is False and body["batch_running"] is False
        assert [(p["printer_id"], p["motor_noise"], p["blocker"]) for p in body["printers"]] == [
            (a, True, None),
            (b, False, "offline"),
        ]

    @pytest.mark.asyncio
    async def test_waiting_printers_say_why(self, async_client: AsyncClient, printer_factory, farm):
        a, b = await _printers(printer_factory, farm, 2)
        farm.report(b, "RUNNING", name="print.3mf")
        await async_client.post(BATCH_URL, json={"printer_ids": [a, b]})

        items = (await async_client.get(BATCH_URL)).json()["items"]

        assert [(i["status"], i["blocker"]) for i in items] == [("waiting", None), ("waiting", "busy")]
