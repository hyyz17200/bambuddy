"""Obico checks on each printer's own clock, a few at a time (obico_scheduler).

Each test runs a fresh ObicoDetectionService with the scheduler attached, with
stand-ins for the printers, their cameras and the ML API, and intervals of a
fraction of a second.
"""

import asyncio
import inspect
import re
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

import backend.app.main  # noqa: F401  register() installs the scheduler on the singleton
from backend.app.hyyz17200 import enhanced_settings, obico_scheduler
from backend.app.services import obico_detection
from backend.app.services.obico_detection import ObicoDetectionService
from backend.app.services.obico_smoothing import WARMUP_FRAMES, PrintState

pytestmark = pytest.mark.integration

JPEG = b"\xff\xd8frame\xff\xd9"


class Farm:
    """Printers, cameras and an ML API for one service."""

    def __init__(self, monkeypatch, printers=(1, 2, 3), *, interval=0.3, max_concurrent=8, enabled=True):
        self.monkeypatch = monkeypatch
        self.statuses = {pid: self.running(pid) for pid in printers}
        self.connected = set(printers)
        self.settings = {
            "enabled": True,
            "ml_url": "http://obico:3333",
            "ml_token": "",
            "sensitivity": "medium",
            "action": "notify",
            "poll_interval": interval,
            "enabled_printers": None,
            "snapshot_base_url": "http://bambuddy:8000",
        }
        self.capture_seconds: dict[int, float] = {}
        self.capture_gate: dict[int, asyncio.Event] = {}
        self.capture_result: dict[int, bytes | None] = {}
        self.ml_seconds = 0.0
        self.detections: dict[int, list] = {}
        self.on_ml = None  # called with the printer id before the ML answer
        self.capturing: dict[int, int] = {}
        self.peak_capturing = 0
        self.peak_per_printer: dict[int, int] = {}
        self.starts: dict[int, list[float]] = {}
        self.action = AsyncMock()

        monkeypatch.setattr(obico_scheduler, "MIN_INTERVAL", 0.01)
        monkeypatch.setattr(obico_scheduler, "SETTINGS_TTL", 0.05)
        monkeypatch.setattr(obico_scheduler, "STATUS_SECONDS", 0.05)

        from backend.app.services import printer_manager as pm_module

        manager = SimpleNamespace(
            get_all_statuses=lambda: dict(self.statuses),
            is_connected=lambda pid: pid in self.connected,
            get_status=lambda pid: self.statuses.get(pid),
        )
        monkeypatch.setattr(pm_module, "printer_manager", manager)
        monkeypatch.setattr("backend.app.services.failure_detection_camera.capture_detection_frame", self._capture)
        monkeypatch.setattr(obico_detection.httpx, "AsyncClient", self._client)
        monkeypatch.setattr("backend.app.services.obico_actions.execute_action", self.action)

        self.svc = ObicoDetectionService()
        self.svc._load_settings = self._load_settings
        self.scheduler = obico_scheduler.ObicoScheduler(
            self.svc, obico_scheduler.ObicoSchedulerSettings(enabled=enabled, max_concurrent=max_concurrent)
        )
        self.scheduler.attach()
        self.scheduler._first_delay = lambda interval: 0.0

    @staticmethod
    def running(pid: int, task: str | None = None, job: str | None = None, layer: int = 5):
        return SimpleNamespace(
            state="RUNNING",
            task_name=task or f"job-{pid}",
            subtask_name="",
            subtask_id=job or str(1000 + pid),
            layer_num=layer,
            total_layers=60,
            stg_cur=0 if layer else 2,
        )

    async def _load_settings(self) -> dict:
        return dict(self.settings)

    async def _capture(self, printer_id, **_kwargs):
        self.starts.setdefault(printer_id, []).append(time.monotonic())
        self.capturing[printer_id] = self.capturing.get(printer_id, 0) + 1
        self.peak_per_printer[printer_id] = max(self.peak_per_printer.get(printer_id, 0), self.capturing[printer_id])
        self.peak_capturing = max(self.peak_capturing, sum(self.capturing.values()))
        try:
            gate = self.capture_gate.get(printer_id)
            if gate is not None:
                await gate.wait()
            await asyncio.sleep(self.capture_seconds.get(printer_id, 0.01))
            return self.capture_result.get(printer_id, JPEG)
        finally:
            self.capturing[printer_id] -= 1

    def _client(self, *args, **kwargs):
        farm = self

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params=None, headers=None):
                check = obico_scheduler._CHECK.get()
                pid = check.printer_id if check else None
                await asyncio.sleep(farm.ml_seconds)
                if farm.on_ml is not None:
                    farm.on_ml(pid)
                return httpx.Response(
                    200, json={"detections": farm.detections.get(pid, [])}, request=httpx.Request("GET", url)
                )

        return _Client()

    def seed_failing(self, pid: int) -> None:
        """A print past warmup whose next frame is far above its baseline."""
        state = PrintState()
        for _ in range(WARMUP_FRAMES + 500):
            state.update(0.0)
        for _ in range(40):
            state.update(3.0)
        status = self.statuses[pid]
        self.svc._states[pid] = state
        self.svc._state_keys[pid] = status.task_name
        self.svc._print_ids[pid] = status.subtask_id
        self.svc._action_fired[pid] = False
        self.detections[pid] = [["failure", 3.0, [0, 0, 1, 1]]]

    def frames(self, pid: int) -> int:
        state = self.svc._states.get(pid)
        return state.frame_count if state else 0

    async def run(self, seconds: float) -> None:
        await self.svc.start()
        await asyncio.sleep(seconds)

    async def close(self) -> None:
        tasks = [t.task for t in self.scheduler._tracks.values() if t.task] + list(self.scheduler._actions)
        loop_task = self.svc._task
        self.svc.stop()
        await asyncio.gather(*tasks, *([loop_task] if loop_task else []), return_exceptions=True)


@pytest.fixture
def farm_factory(monkeypatch):
    farms = []

    def make(*args, **kwargs) -> Farm:
        farm = Farm(monkeypatch, *args, **kwargs)
        farms.append(farm)
        return farm

    yield make
    loop = asyncio.get_event_loop()
    for farm in farms:
        if farm.svc._task is not None or farm.scheduler._actions:
            loop.run_until_complete(farm.close())


def _avg_gap(times: list[float]) -> float:
    return (times[-1] - times[0]) / (len(times) - 1)


class TestScheduling:
    async def test_checks_run_side_by_side_up_to_the_limit(self, farm_factory):
        farm = farm_factory(printers=range(1, 7), interval=5, max_concurrent=3)
        for pid in range(1, 7):
            farm.capture_seconds[pid] = 0.2
        await farm.run(0.55)
        await farm.close()
        assert farm.peak_capturing == 3
        assert max(farm.peak_per_printer.values()) == 1
        # Two waves of three, not six checks one after another (1.2s).
        assert all(farm.frames(pid) == 1 for pid in range(1, 7))

    async def test_a_slow_printer_does_not_hold_up_the_others(self, farm_factory):
        farm = farm_factory(printers=(1, 2, 3), interval=0.2)
        farm.capture_seconds[1] = 1.0
        await farm.run(1.3)
        await farm.close()
        assert farm.frames(2) >= 5 and farm.frames(3) >= 5
        # The slow one: never two at once, no make-up checks for the missed periods.
        assert farm.peak_per_printer[1] == 1
        assert len(farm.starts[1]) == 2
        assert farm.scheduler._tracks[1].overruns >= 1

    async def test_the_period_is_the_interval_not_the_interval_plus_the_round(self, farm_factory):
        # One after the other: a farm patches the printer manager and the camera.
        farms = []
        for enabled in (True, False):
            farm = farm_factory(printers=(1, 2, 3, 4), interval=0.3, enabled=enabled)
            for pid in (1, 2, 3, 4):
                farm.capture_seconds[pid] = 0.1
            await farm.run(1.6)
            await farm.close()
            farms.append(farm)
        concurrent, sequential = farms
        assert 0.27 <= _avg_gap(concurrent.starts[1]) <= 0.4
        # Upstream's loop: four checks of 0.1s, then the interval.
        assert _avg_gap(sequential.starts[1]) >= 0.65
        assert sequential.peak_capturing == 1

    async def test_due_printers_share_the_slots_fairly(self, farm_factory):
        farm = farm_factory(printers=(1, 2, 3, 4), interval=0.05, max_concurrent=1)
        for pid in (1, 2, 3, 4):
            farm.capture_seconds[pid] = 0.04
        await farm.run(1.0)
        await farm.close()
        counts = [len(farm.starts[pid]) for pid in (1, 2, 3, 4)]
        assert max(counts) - min(counts) <= 1
        assert farm.peak_capturing == 1
        assert sum(farm.scheduler._tracks[pid].waits for pid in (1, 2, 3, 4)) > 0

    async def test_a_paused_print_is_not_checked_and_keeps_its_state(self, farm_factory):
        farm = farm_factory(printers=(1,), interval=0.1)
        await farm.run(0.35)
        state = farm.svc._states[1]
        frames = state.frame_count
        assert frames >= 3
        farm.statuses[1].state = "PAUSE"
        await asyncio.sleep(0.15)  # a check already running may still finish
        frames = state.frame_count
        await asyncio.sleep(0.3)
        assert state.frame_count == frames
        farm.statuses[1].state = "RUNNING"
        await asyncio.sleep(0.3)
        await farm.close()
        assert farm.svc._states[1] is state
        assert state.frame_count > frames

    async def test_an_ended_print_cancels_its_check_and_starts_fresh(self, farm_factory):
        farm = farm_factory(printers=(1,), interval=0.1)
        farm.capture_gate[1] = asyncio.Event()
        await farm.run(0.1)
        task = farm.scheduler._tracks[1].task
        assert task is not None
        farm.statuses[1].state = "FINISH"
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
        assert task.cancelled()
        assert 1 not in farm.svc._states
        await farm.close()

    async def test_a_failing_printer_is_checked_less_often(self, farm_factory, monkeypatch):
        monkeypatch.setattr(obico_scheduler, "BACKOFF_CAP", 0.4)
        farm = farm_factory(printers=(1, 2), interval=0.05)
        farm.capture_result[1] = None
        await farm.run(1.0)
        await farm.close()
        # 0.05, 0.1, 0.2, 0.4, 0.4 ... instead of every 0.05s
        assert len(farm.starts[1]) <= 6
        assert len(farm.starts[2]) >= 12
        assert farm.svc.get_per_printer()[1]["class"] == "error"

    async def test_a_stuck_check_gives_its_slot_back(self, farm_factory, monkeypatch):
        monkeypatch.setattr(obico_scheduler, "CHECK_DEADLINE", 0.2)
        farm = farm_factory(printers=(1, 2), interval=0.1, max_concurrent=1)
        farm.capture_gate[1] = asyncio.Event()  # never opens
        await farm.run(0.5)
        await farm.close()
        assert "took longer than" in farm.svc._errors[1]
        assert farm.frames(2) >= 1

    async def test_the_limit_and_the_mode_change_while_running(self, farm_factory):
        farm = farm_factory(printers=range(1, 5), interval=0.1, max_concurrent=1)
        for pid in range(1, 5):
            farm.capture_seconds[pid] = 0.1
        await farm.run(0.3)
        assert farm.peak_capturing == 1
        farm.scheduler.configure(obico_scheduler.ObicoSchedulerSettings(max_concurrent=4))
        await asyncio.sleep(0.3)
        assert farm.peak_capturing == 4
        farm.peak_capturing = 0
        farm.scheduler.configure(obico_scheduler.ObicoSchedulerSettings(enabled=False))
        await asyncio.sleep(0.25)
        farm.peak_capturing = 0
        await asyncio.sleep(0.5)
        await farm.close()
        assert farm.peak_capturing == 1


class TestFirstLayer:
    """The start sequence (leveling, heating, wiping, purging) prints nothing."""

    @pytest.mark.parametrize("enabled", [True, False])
    async def test_a_printer_is_first_checked_on_layer_one(self, farm_factory, enabled):
        farm = farm_factory(printers=(1, 2), interval=0.05, enabled=enabled)
        farm.statuses[1] = Farm.running(1, layer=0)
        await farm.run(0.4)
        assert 1 not in farm.starts and 1 not in farm.svc._states
        assert farm.frames(2) >= 2
        if enabled:
            assert farm.scheduler.snapshot(lambda pid: True)["preparing"] == 1
        farm.statuses[1].layer_num = 1
        farm.statuses[1].stg_cur = 0
        await asyncio.sleep(0.4)
        await farm.close()
        assert farm.frames(1) >= 2

    async def test_off_it_is_checked_from_the_start(self, farm_factory):
        farm = farm_factory(printers=(1,), interval=0.05)
        farm.scheduler.configure(obico_scheduler.ObicoSchedulerSettings(skip_preparation=False))
        farm.statuses[1] = Farm.running(1, layer=0)
        await farm.run(0.3)
        await farm.close()
        assert farm.frames(1) >= 2

    @pytest.mark.parametrize(
        ("layer", "total", "stage", "preparing"),
        [
            (0, 60, 0, True),  # a layer count, no layer yet
            (1, 60, 0, False),
            (0, 0, 2, True),  # no count yet: heatbed preheating
            (0, 0, 14, True),  # cleaning the nozzle tip
            (0, 0, 0, False),  # "Printing"
            (0, 0, -1, False),  # reports neither: as before
            (0, 0, 255, False),
            (None, None, None, False),
        ],
    )
    def test_before_layer_one_is_upstreams_rule(self, layer, total, stage, preparing):
        status = SimpleNamespace(layer_num=layer, total_layers=total, stg_cur=stage)
        assert obico_scheduler._preparing(status) is preparing
        assert obico_scheduler._preparing(SimpleNamespace()) is False

    async def test_the_time_before_layer_one_is_not_a_missing_result(self, farm_factory, monkeypatch):
        monkeypatch.setattr(obico_scheduler, "STALE_MIN", 0.2)
        farm = farm_factory(printers=(1,), interval=0.05)
        await farm.run(0.15)
        farm.statuses[1].layer_num = 0  # say, a reconnect before the next report
        farm.statuses[1].stg_cur = 1
        await asyncio.sleep(0.4)
        await farm.close()
        assert farm.svc.get_per_printer()[1]["class"] == "safe"


class TestActions:
    async def test_a_result_for_the_next_print_does_not_act(self, farm_factory):
        """The ML answer arrives after another print started on the printer."""
        farm = farm_factory(printers=(1,))
        farm.settings["action"] = "pause"
        farm.seed_failing(1)

        def next_print(pid):
            farm.statuses[1] = Farm.running(1, task="next-print", job="2002")

        farm.on_ml = next_print
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        await asyncio.sleep(0)
        farm.action.assert_not_awaited()
        assert farm.svc._action_fired[1] is False
        assert farm.scheduler._tracks[1].dropped_actions == 1

        # The next check sees the new print and starts it fresh.
        farm.on_ml = None
        farm.detections[1] = []
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        assert farm.svc._state_keys[1] == "next-print"
        assert farm.svc._states[1].frame_count == 1

    @pytest.mark.parametrize("state", ["PAUSE", "FINISH", "IDLE"])
    async def test_a_printer_that_stopped_running_is_not_acted_on(self, farm_factory, state):
        farm = farm_factory(printers=(1,))
        farm.settings["action"] = "pause"
        farm.seed_failing(1)
        farm.on_ml = lambda pid: setattr(farm.statuses[1], "state", state)
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        await asyncio.sleep(0)
        farm.action.assert_not_awaited()

    async def test_a_restart_or_an_ended_print_drops_the_result(self, farm_factory):
        farm = farm_factory(printers=(1,))
        farm.settings["action"] = "pause"
        farm.seed_failing(1)
        farm.on_ml = lambda pid: farm.scheduler._cancel(actions=True)  # stop()/refresh meanwhile
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        farm.on_ml = lambda pid: farm.scheduler._epochs.__setitem__(1, farm.scheduler._epochs.get(1, 0) + 1)
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        await asyncio.sleep(0)
        farm.action.assert_not_awaited()
        assert farm.scheduler._tracks[1].dropped_actions == 2

    async def test_a_changed_setting_drops_the_result_and_the_next_check_decides(self, farm_factory):
        farm = farm_factory(printers=(1,))
        farm.settings["action"] = "pause"
        farm.seed_failing(1)
        farm.on_ml = lambda pid: farm.settings.__setitem__("action", "notify")
        await farm.svc._check_printer(1, farm.statuses[1], {**farm.settings, "action": "pause"})
        await asyncio.sleep(0)
        farm.action.assert_not_awaited()
        assert farm.svc._action_fired[1] is False

        farm.on_ml = None
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        await asyncio.sleep(0)
        farm.action.assert_awaited_once()
        assert farm.action.await_args.args[:2] == (1, "notify")

    async def test_a_turned_off_or_deselected_printer_is_not_acted_on(self, farm_factory):
        farm = farm_factory(printers=(1, 2))
        farm.seed_failing(1)
        farm.seed_failing(2)
        farm.on_ml = lambda pid: farm.settings.__setitem__("enabled_printers", {2})
        await farm.svc._check_printer(1, farm.statuses[1], {**farm.settings, "enabled_printers": None})
        farm.on_ml = lambda pid: farm.settings.__setitem__("enabled", False)
        await farm.svc._check_printer(2, farm.statuses[2], dict(farm.settings, enabled=True))
        await asyncio.sleep(0)
        farm.action.assert_not_awaited()

    async def test_one_print_acts_once_while_checks_keep_coming(self, farm_factory):
        farm = farm_factory(printers=(1, 2), interval=0.05)
        farm.settings["action"] = "pause"
        farm.seed_failing(1)
        farm.seed_failing(2)
        await farm.run(0.6)
        await farm.close()
        assert farm.frames(1) >= 5
        assert sorted(call.args[0] for call in farm.action.await_args_list) == [1, 2]

    async def test_stop_cancels_checks_and_running_actions(self, farm_factory):
        farm = farm_factory(printers=(1, 2), interval=0.05)
        farm.settings["action"] = "pause_and_off"
        farm.seed_failing(1)
        farm.capture_gate[2] = asyncio.Event()
        started, release = asyncio.Event(), asyncio.Event()
        finished = []

        async def slow_action(*args, **kwargs):
            started.set()
            await release.wait()  # say, the plug is slow to answer
            finished.append(args)

        farm.action.side_effect = slow_action
        await farm.svc.start()
        await asyncio.wait_for(started.wait(), 2)
        check = farm.scheduler._tracks[2].task
        action = next(iter(farm.scheduler._actions))
        farm.svc.stop()
        await asyncio.gather(check, action, return_exceptions=True)
        release.set()
        await asyncio.sleep(0.05)
        assert check.cancelled() and action.cancelled()
        assert finished == []
        assert farm.svc._task is None

    async def test_a_cancelled_check_leaves_its_action_running(self, farm_factory):
        farm = farm_factory(printers=(1,), interval=5)
        farm.settings["action"] = "pause"
        farm.seed_failing(1)
        release = asyncio.Event()

        async def slow_action(*args, **kwargs):
            await release.wait()

        farm.action.side_effect = slow_action
        await farm.svc._check_printer(1, farm.statuses[1], dict(farm.settings))
        action = next(iter(farm.scheduler._actions))
        farm.statuses[1].state = "FINISH"
        farm.svc._end_print(1)  # what the loop does when it sees the print end
        await asyncio.sleep(0.05)
        assert not action.done()
        release.set()
        await action
        farm.action.assert_awaited_once()

    async def test_refresh_settings_returns_once_the_old_checks_are_gone(self, farm_factory):
        farm = farm_factory(printers=(1, 2), interval=0.05)
        farm.capture_gate[1] = asyncio.Event()
        farm.capture_gate[2] = asyncio.Event()
        await farm.run(0.1)
        old = [t.task for t in farm.scheduler._tracks.values()]
        assert all(old)
        await farm.svc.refresh_settings()
        assert all(task.done() for task in old)
        assert farm.svc._task is not None  # restarted
        await farm.close()

    async def test_forgetting_a_printer_cancels_only_its_check(self, farm_factory):
        farm = farm_factory(printers=(1, 2), interval=0.05)
        farm.capture_gate[1] = asyncio.Event()
        farm.capture_gate[2] = asyncio.Event()
        await farm.run(0.1)
        one, two = farm.scheduler._tracks[1].task, farm.scheduler._tracks[2].task
        # main.forget_printer drops it from the printer manager first.
        del farm.statuses[1]
        farm.svc.forget_printer(1)
        await asyncio.sleep(0.02)
        assert one.cancelled() and not two.done()
        assert 1 not in farm.scheduler._tracks
        await farm.close()

    async def test_without_the_scheduler_the_action_is_upstreams(self, farm_factory):
        farm = farm_factory(printers=(1,))
        await farm.svc._dispatch_action(1, "notify", "job", 1.0, JPEG)
        farm.action.assert_awaited_once()


class TestStaleVerdicts:
    async def test_a_printer_with_no_result_for_a_while_shows_an_error(self, farm_factory, monkeypatch):
        monkeypatch.setattr(obico_scheduler, "STALE_MIN", 0.3)
        farm = farm_factory(printers=(1,), interval=0.05)
        await farm.run(0.15)
        assert farm.svc.get_per_printer()[1]["class"] == "safe"
        farm.capture_gate[1] = asyncio.Event()  # the next check hangs
        await asyncio.sleep(0.5)
        entry = farm.svc.get_per_printer()[1]
        assert entry["class"] == "error"
        assert entry["error"].startswith("No detection result for")
        farm.capture_gate[1].set()
        del farm.capture_gate[1]
        await asyncio.sleep(0.2)
        await farm.close()
        assert farm.svc.get_per_printer()[1]["class"] == "safe"

    async def test_a_disconnected_printer_shows_an_error_but_a_paused_one_does_not(self, farm_factory, monkeypatch):
        monkeypatch.setattr(obico_scheduler, "STALE_MIN", 0.2)
        farm = farm_factory(printers=(1, 2), interval=0.05)
        await farm.run(0.15)
        farm.connected.discard(1)
        farm.statuses[2].state = "PAUSE"
        await asyncio.sleep(0.4)
        await farm.close()
        per_printer = farm.svc.get_per_printer()
        assert per_printer[1]["class"] == "error"
        assert "disconnected" in per_printer[1]["error"]
        assert per_printer[2]["class"] == "safe"


class TestNumbers:
    async def test_each_check_is_timed(self, farm_factory):
        farm = farm_factory(printers=(1,), interval=0.1)
        farm.capture_seconds[1] = 0.1
        farm.ml_seconds = 0.05
        await farm.run(0.7)
        row = farm.scheduler.snapshot(lambda pid: True)["printers"][1]
        await farm.close()
        assert row["printing"] is True
        assert row["ok"] >= 3 and row["failed"] == 0
        assert 0.09 <= row["capture"] <= 0.2
        assert 0.04 <= row["ml"] <= 0.15
        # 0.15s a check, so each one overruns the 0.1s interval and the next starts at once.
        assert 0.14 <= row["period"] <= 0.25
        assert row["overruns"] >= 2

    async def test_a_summary_line_a_minute(self, farm_factory, monkeypatch, caplog):
        monkeypatch.setattr(obico_scheduler, "SUMMARY_SECONDS", 0.3)
        farm = farm_factory(printers=(1, 2), interval=0.05)
        with caplog.at_level("INFO", logger=obico_scheduler.logger.name):
            await farm.run(0.7)
            await farm.close()
        lines = [r.getMessage() for r in caplog.records if "checks in the last minute" in r.getMessage()]
        assert lines
        assert re.search(r"concurrent, 2 printers, \d+ checks", lines[-1])


class TestSharedTls:
    def test_clients_share_one_context(self):
        proxy = obico_scheduler._SharedTlsHttpx()
        started = time.perf_counter()
        clients = [proxy.AsyncClient(timeout=1.0) for _ in range(20)]
        elapsed = time.perf_counter() - started
        contexts = {id(c._transport._pool._ssl_context) for c in clients}
        assert len(contexts) == 1
        assert elapsed < 0.5  # one context, not twenty (each ~150ms on Windows)
        assert proxy.TimeoutException is httpx.TimeoutException

    def test_a_client_with_its_own_verify_keeps_it(self):
        proxy = obico_scheduler._SharedTlsHttpx()
        client = proxy.AsyncClient(verify=False)
        assert client._transport._pool._ssl_context is not obico_scheduler._tls_context()


class TestSettings:
    def test_registered_with_defaults(self):
        assert enhanced_settings.SECTIONS["obico"] is obico_scheduler.ObicoSchedulerSettings
        assert enhanced_settings.APPLY["obico"] is obico_scheduler.apply_settings
        defaults = obico_scheduler.ObicoSchedulerSettings()
        assert defaults.enabled is True
        assert defaults.max_concurrent == obico_scheduler.DEFAULT_MAX_CONCURRENT
        assert defaults.skip_preparation is True

    async def test_saving_applies_to_the_running_scheduler(self, async_client):
        response = await async_client.put(
            "/api/v1/hyyz17200/settings/obico", json={"enabled": True, "max_concurrent": 3}
        )
        assert response.status_code == 200
        try:
            assert obico_scheduler.scheduler.max_concurrent == 3
        finally:
            enhanced_settings.apply("obico", obico_scheduler.ObicoSchedulerSettings())

    async def test_the_limit_is_bounded(self, async_client):
        response = await async_client.put("/api/v1/hyyz17200/settings/obico", json={"max_concurrent": 0})
        assert response.status_code == 422

    async def test_the_status_route(self, async_client, printer_factory):
        printer = await printer_factory(name="A1-001")
        scheduler = obico_scheduler.scheduler
        scheduler._tracks[printer.id] = obico_scheduler._Track(active=True, checks=3, ok=2, failed=1)
        try:
            response = await async_client.get("/api/v1/hyyz17200/obico/scheduler")
        finally:
            scheduler._tracks.pop(printer.id, None)
        assert response.status_code == 200
        body = response.json()
        assert body["mode"] == "concurrent"
        row = next(r for r in body["printers"] if r["printer_id"] == printer.id)
        assert (row["name"], row["checks"], row["ok"], row["failed"]) == ("A1-001", 3, 2, 1)


class TestUpstreamContracts:
    """What the scheduler relies on in obico_detection. A failure here after a
    rebase means: read upstream's change and adjust obico_scheduler."""

    def test_installed_on_the_singleton(self):
        svc = obico_detection.obico_detection_service
        assert isinstance(svc.hyyz17200_scheduler, obico_scheduler.ObicoScheduler)
        assert obico_scheduler.scheduler is svc.hyyz17200_scheduler
        for name in ("_loop", "_check_printer", "_capture_frame", "_dispatch_action", "_end_print"):
            assert getattr(svc, name).__self__ is svc.hyyz17200_scheduler, name
        for name in ("stop", "refresh_settings", "forget_printer"):
            assert getattr(svc, name).__self__ is svc.hyyz17200_scheduler, name
        assert isinstance(obico_detection.httpx, obico_scheduler._SharedTlsHttpx)

    def test_the_lifecycle_goes_through_the_instance(self):
        source = inspect.getsource(ObicoDetectionService.start)
        assert "asyncio.create_task(self._loop())" in source
        refresh = inspect.getsource(ObicoDetectionService.refresh_settings)
        assert "self.stop()" in refresh and "await self.start()" in refresh

    def test_the_loop_being_replaced(self):
        # Sequential mode runs upstream's _poll_once with the same interval.
        source = inspect.getsource(ObicoDetectionService._loop)
        assert 'interval = max(5, settings.get("poll_interval", 10))' in source
        assert "await self._poll_once(settings)" in source
        assert "await asyncio.sleep(interval)" in source

    def test_poll_once_filters_are_the_ones_the_tick_repeats(self):
        source = inspect.getsource(ObicoDetectionService._poll_once)
        for line in (
            "statuses = printer_manager.get_all_statuses()",
            'if settings["enabled_printers"] is not None and printer_id not in settings["enabled_printers"]:',
            "if not printer_manager.is_connected(printer_id):",
            'print_state = getattr(status, "state", None) if status else None',
            'if print_state != "RUNNING":',
            "if print_state is None or print_state in _ENDED_STATES:",
            "self._end_print(printer_id)",
            "await self._check_printer(printer_id, status, settings)",
        ):
            assert line in source, line
        # Nothing else happens per printer.
        assert source.count("printer_id") == 5

    def test_the_check_calls_through_the_instance_in_this_order(self):
        source = inspect.getsource(ObicoDetectionService._check_printer)
        key = 'task_name = getattr(status, "task_name", None) or getattr(status, "subtask_name", "") or ""'
        assert key in source
        assert "job_id = self._job_id(status)" in source
        capture = source.index("frame = await self._capture_frame(printer_id)")
        client = source.index("httpx.AsyncClient(timeout=DETECTION_TIMEOUT)")
        update = source.index("reading = state.update(current_p)")
        fired = source.index("self._action_fired[printer_id] = True")
        dispatch = source.index('await self._dispatch_action(printer_id, settings["action"], task_name, score, frame)')
        assert capture < client < update < fired < dispatch
        # The action guard reads the state the check just updated.
        assert "await" not in source[update:dispatch]
        assert "self._errors.pop(printer_id, None)" in source
        assert "if state is None:" in source  # a forgotten printer's late answer is dropped

    def test_the_wrapped_signatures(self):
        def params(fn):
            return list(inspect.signature(fn).parameters)

        assert params(ObicoDetectionService._dispatch_action) == [
            "self",
            "printer_id",
            "action",
            "task_name",
            "score",
            "frame",
        ]
        assert params(ObicoDetectionService._capture_frame) == ["self", "printer_id"]
        assert params(ObicoDetectionService._end_print) == ["self", "printer_id"]
        assert params(ObicoDetectionService.forget_printer) == ["self", "printer_id"]
        assert params(ObicoDetectionService._no_verdict) == ["self", "printer_id", "reason"]
        assert params(ObicoDetectionService._check_printer) == ["self", "printer_id", "status", "settings"]
        assert isinstance(inspect.getattr_static(ObicoDetectionService, "_job_id"), staticmethod)
        assert "FINISH" in obico_detection._ENDED_STATES

    def test_an_error_entry_is_what_the_cards_show(self):
        svc = ObicoDetectionService()
        svc._states[1] = PrintState()
        svc._last_class[1] = "safe"
        svc._errors[1] = "No detection result for 60s"
        assert svc.get_per_printer()[1]["class"] == "error"

    def test_before_layer_one_is_the_rule_main_uses(self):
        import backend.app.main as main_module
        from backend.app.services.bambu_mqtt import PrinterState

        assert main_module._NO_PREPARATION_STAGES == obico_scheduler.NO_PREPARATION_STAGES
        source = inspect.getsource(main_module._progress_milestone_to_notify)
        assert "if (state.layer_num or 0) < 1:" in source
        assert "if (state.total_layers or 0) > 0:" in source
        assert "if state.stg_cur not in _NO_PREPARATION_STAGES:" in source
        state = PrinterState()
        assert (state.layer_num, state.total_layers, state.stg_cur) == (0, 0, -1)
        # A new print starts from layer 0, not the last print's last layer.
        from backend.app.services import bambu_mqtt

        assert "self.state.layer_num = 0" in inspect.getsource(bambu_mqtt.BambuMQTTClient)

    def test_httpx_still_builds_its_default_context(self):
        assert isinstance(httpx.create_ssl_context(), __import__("ssl").SSLContext)
