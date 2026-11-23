"""Auto camera LED: the light is on for the whole print, off once idle (hyyz17200)."""

import asyncio
import inspect
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

import backend.app.main  # noqa: F401  (installs the fork's wrappers)
from backend.app.hyyz17200 import camera_led, enhanced_settings
from backend.app.hyyz17200.camera_led import CameraLedSettings
from backend.app.services import camera_light
from backend.app.services.bambu_mqtt import BambuMQTTClient, PrinterState

URL = "/api/v1/hyyz17200/settings"


class FakeClient:
    def __init__(self, state):
        self.state = state
        self.sent: list[bool] = []

    def set_chamber_light(self, on: bool) -> bool:
        self.sent.append(on)
        return True


class Farm:
    def __init__(self, monkeypatch):
        self.printers: dict[int, FakeClient] = {}
        self.now = 1000.0
        pm = camera_led.printer_manager
        monkeypatch.setattr(pm, "get_all_statuses", lambda: {pid: c.state for pid, c in self.printers.items()})
        monkeypatch.setattr(pm, "get_client", lambda pid: self.printers.get(pid))
        monkeypatch.setattr(camera_led, "_now", lambda: self.now)

    def add(self, pid: int, *, state="IDLE", light=False) -> FakeClient:
        client = FakeClient(SimpleNamespace(connected=True, state=state, chamber_light=light))
        self.printers[pid] = client
        return client

    async def tick(self, advance: float = 0.0):
        self.now += advance
        await camera_led.tick()
        await asyncio.sleep(0)  # let a two-step switch run
        await asyncio.sleep(0)


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(camera_led, "RESYNC_GAP_SECONDS", 0)
    camera_led._tracks.clear()
    camera_led._manual_at.clear()
    camera_led._pending.clear()
    camera_led._obico_cache = None
    camera_light._holders.clear()
    camera_light._lit_at.clear()
    camera_light._off_tasks.clear()
    camera_led.apply_settings(CameraLedSettings(enabled=True))
    yield
    for task in camera_led._pending.values():
        task.cancel()
    camera_led.apply_settings(CameraLedSettings())
    camera_light._holders.clear()
    camera_light._lit_at.clear()
    camera_light._off_tasks.clear()


@pytest.fixture
def farm(monkeypatch):
    return Farm(monkeypatch)


@pytest.fixture(autouse=True)
def holds(monkeypatch):
    """What the camera hold is asked to keep connected, pass by pass."""
    calls: list[set[int]] = []
    monkeypatch.setattr(camera_led.camera_hold, "hold", lambda ids: calls.append(set(ids)))
    released: list[bool] = []
    monkeypatch.setattr(camera_led.camera_hold, "release_all", lambda: released.append(True))
    return SimpleNamespace(calls=calls, released=released)


def obico(monkeypatch, *, enabled=True, printers=None):
    from backend.app.services.obico_detection import obico_detection_service

    async def load():
        return {"enabled": enabled, "ml_url": "http://obico" if enabled else "", "enabled_printers": printers}

    monkeypatch.setattr(obico_detection_service, "_load_settings", load)


class TestSwitching:
    @pytest.mark.asyncio
    async def test_a_light_reported_off_gets_one_on(self, farm):
        a1 = farm.add(1, state="PREPARE", light=False)
        await farm.tick()
        assert a1.sent == [True]

    @pytest.mark.asyncio
    async def test_a_light_reported_on_is_not_trusted(self, farm):
        """An A1 after a power cycle can report on while dark: off first, then on."""
        a1 = farm.add(1, state="PREPARE", light=True)
        await farm.tick()
        assert a1.sent == [False, True]

    @pytest.mark.asyncio
    async def test_idle_printers_are_left_alone(self, farm):
        a1 = farm.add(1, state="IDLE", light=True)
        a2 = farm.add(2, state="FINISH", light=False)
        await farm.tick()
        await farm.tick(600)
        assert a1.sent == [] and a2.sent == []

    @pytest.mark.asyncio
    async def test_off_after_the_delay(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        await farm.tick(1)
        await farm.tick(59)
        assert a1.sent == [True]
        await farm.tick(1)
        assert a1.sent == [True, False]
        await farm.tick(600)
        assert a1.sent == [True, False]

    @pytest.mark.asyncio
    async def test_off_reported_off_already_is_not_trusted(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.state = "IDLE"  # light still reported off
        await farm.tick(1)
        await farm.tick(60)
        assert a1.sent == [True, True, False]

    @pytest.mark.asyncio
    async def test_back_to_back_jobs_keep_the_light(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        await farm.tick(5)
        a1.state.state = "PREPARE"
        await farm.tick(30)
        a1.state.state = "FINISH"
        await farm.tick(1)
        await farm.tick(60)
        assert a1.sent == [True, False]

    @pytest.mark.asyncio
    async def test_paused_prints_keep_the_light(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.state = "PAUSE"
        await farm.tick(600)
        assert a1.sent == [True]


class TestDuringThePrint:
    @pytest.mark.asyncio
    async def test_switched_off_elsewhere_comes_back(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        await farm.tick(5)  # report not in yet: no second "on"
        assert a1.sent == [True]
        a1.state.chamber_light = True
        await farm.tick(30)
        a1.state.chamber_light = False  # Handy or the screen
        await farm.tick(5)
        assert a1.sent == [True, True]

    @pytest.mark.asyncio
    async def test_a_switch_through_bambuddy_is_respected(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        await farm.tick(30)
        camera_light.hand_back(1)  # the card's light button
        a1.state.chamber_light = False
        await farm.tick(30)
        await farm.tick(30)
        assert a1.sent == [True]

    @pytest.mark.asyncio
    async def test_the_next_print_is_lit_again_after_a_manual_off(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        await farm.tick(30)
        camera_light.hand_back(1)
        a1.state.chamber_light = False
        a1.state.state = "FINISH"
        await farm.tick(30)
        await farm.tick(60)  # off delay: reported off, so on then off
        assert a1.sent == [True, True, False]
        a1.sent.clear()
        a1.state.state = "PREPARE"
        await farm.tick(300)
        assert a1.sent == [True]

    @pytest.mark.asyncio
    async def test_obico_force_ignores_a_manual_off(self, farm, monkeypatch):
        obico(monkeypatch)
        camera_led.apply_settings(CameraLedSettings(enabled=True, obico_force=True))
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        await farm.tick(30)
        camera_light.hand_back(1)
        a1.state.chamber_light = False
        await farm.tick(30)
        assert a1.sent == [True, True]

    @pytest.mark.asyncio
    async def test_the_light_is_taken_from_the_camera(self, farm):
        """Upstream's camera light must not switch off a light held for a print."""
        a1 = farm.add(1, state="RUNNING", light=False)
        camera_light._lit_at[1] = 1.0
        off = asyncio.get_running_loop().create_task(asyncio.sleep(3600))
        camera_light._off_tasks[1] = off
        await farm.tick()
        await asyncio.sleep(0)
        assert 1 not in camera_light._lit_at and off.cancelled()
        assert 1 not in camera_led._manual_at  # not a user's switch
        camera_light._lit_at[1] = 2.0  # a snapshot switched it on meanwhile
        a1.state.chamber_light = True
        await farm.tick(5)
        assert 1 not in camera_light._lit_at

    @pytest.mark.asyncio
    async def test_a_camera_in_use_at_the_end_gets_the_light(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        camera_light._holders[1] = 1  # a live view
        await farm.tick(1)
        await farm.tick(60)
        assert a1.sent == [True]
        assert 1 in camera_light._lit_at  # upstream switches it off once let go

    @pytest.mark.asyncio
    async def test_a_switch_after_the_end_is_left(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        await farm.tick(1)
        farm.now += 1
        camera_light.hand_back(1)
        await farm.tick(600)
        assert a1.sent == [True]

    @pytest.mark.asyncio
    async def test_a_reconnect_switches_again(self, farm):
        """The printer may have restarted: its reported light is not trusted."""
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.chamber_light = True
        a1.state.connected = False
        await farm.tick(30)
        a1.state.connected = True
        await farm.tick(30)
        assert a1.sent == [True, False, True]

    @pytest.mark.asyncio
    async def test_a_new_print_cancels_a_two_step_off(self, farm, monkeypatch):
        monkeypatch.setattr(camera_led, "RESYNC_GAP_SECONDS", 3600)
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.state = "IDLE"  # reported off: the off goes as on, gap, off
        await farm.tick(1)
        await farm.tick(60)
        assert a1.sent == [True, True]
        a1.state.state = "PREPARE"
        await farm.tick(1)
        assert a1.sent == [True, True, True]
        assert not camera_led._pending  # the off never comes
        assert a1.sent[-1] is True


class TestScope:
    @pytest.mark.asyncio
    async def test_off_does_nothing(self, farm):
        camera_led.apply_settings(CameraLedSettings())
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        assert a1.sent == []

    @pytest.mark.asyncio
    async def test_switching_off_lets_go_without_touching_lights(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        camera_led.apply_settings(CameraLedSettings())
        a1.state.state = "FINISH"
        await farm.tick(600)
        assert a1.sent == [True] and not camera_led._tracks

    @pytest.mark.asyncio
    async def test_obico_force_alone_lights_only_monitored_printers(self, farm, monkeypatch):
        obico(monkeypatch, printers={1})
        camera_led.apply_settings(CameraLedSettings(obico_force=True))
        a1 = farm.add(1, state="RUNNING", light=False)
        a2 = farm.add(2, state="RUNNING", light=False)
        await farm.tick()
        assert a1.sent == [True] and a2.sent == []
        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        await farm.tick(1)
        await farm.tick(60)
        assert a1.sent == [True, False]

    @pytest.mark.asyncio
    async def test_obico_force_with_obico_off_does_nothing(self, farm, monkeypatch):
        obico(monkeypatch, enabled=False)
        camera_led.apply_settings(CameraLedSettings(obico_force=True))
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        assert a1.sent == []

    @pytest.mark.asyncio
    async def test_offline_printers_are_skipped(self, farm):
        a1 = farm.add(1, state="RUNNING", light=False)
        a1.state.connected = False
        await farm.tick()
        assert a1.sent == []


class TestCameraHold:
    @pytest.mark.asyncio
    async def test_listed_printers_are_held_while_their_light_is(self, farm, holds):
        camera_led.apply_settings(CameraLedSettings(enabled=True, keep_camera_printer_ids=[1]))
        a1 = farm.add(1, state="RUNNING", light=False)
        farm.add(2, state="RUNNING", light=False)  # lit, not listed
        farm.add(3, state="IDLE")
        await farm.tick()
        assert holds.calls[-1] == {1}

        a1.state.chamber_light = True
        a1.state.state = "FINISH"
        await farm.tick(1)
        await farm.tick(30)
        assert holds.calls[-1] == {1}  # through the off delay
        await farm.tick(30)
        assert holds.calls[-1] == set()
        assert a1.sent == [True, False]

    @pytest.mark.asyncio
    async def test_not_while_disconnected(self, farm, holds):
        camera_led.apply_settings(CameraLedSettings(enabled=True, keep_camera_printer_ids=[1]))
        a1 = farm.add(1, state="RUNNING", light=False)
        await farm.tick()
        a1.state.connected = False
        await farm.tick(5)
        assert holds.calls == [{1}, set()]
        a1.state.connected = True
        await farm.tick(5)
        assert holds.calls[-1] == {1}

    @pytest.mark.asyncio
    async def test_obico_force_alone_holds_monitored_printers(self, farm, holds, monkeypatch):
        obico(monkeypatch, printers={1})
        camera_led.apply_settings(CameraLedSettings(obico_force=True, keep_camera_printer_ids=[1, 2]))
        farm.add(1, state="RUNNING")
        farm.add(2, state="RUNNING")
        await farm.tick()
        assert holds.calls[-1] == {1}

    def test_turning_the_feature_off_lets_go(self, holds):
        camera_led.apply_settings(CameraLedSettings(enabled=True, keep_camera_printer_ids=[1]))
        assert holds.released == []
        camera_led.apply_settings(CameraLedSettings(keep_camera_printer_ids=[1]))
        assert holds.released == [True]

    def test_stopping_the_runner_lets_go(self, holds):
        camera_led.runner.stop()
        assert holds.released == [True]


class TestSettings:
    def test_it_is_an_enhanced_settings_section(self):
        assert enhanced_settings.SECTIONS["camera_led"] is CameraLedSettings
        assert enhanced_settings.APPLY["camera_led"] is camera_led.apply_settings

    @pytest.mark.asyncio
    async def test_it_starts_off(self, async_client: AsyncClient):
        section = (await async_client.get(URL)).json()["camera_led"]
        assert section == {
            "enabled": False,
            "obico_force": False,
            "off_delay_seconds": 60,
            "keep_camera_printer_ids": [],
        }

    @pytest.mark.asyncio
    async def test_saving_applies_it(self, async_client: AsyncClient):
        value = {"enabled": True, "obico_force": True, "off_delay_seconds": 120, "keep_camera_printer_ids": [3, 7]}
        assert (await async_client.put(f"{URL}/camera_led", json=value)).status_code == 200
        assert (await async_client.get(URL)).json()["camera_led"] == value
        assert camera_led._settings == CameraLedSettings(**value)

    @pytest.mark.asyncio
    async def test_the_delay_is_bounded(self, async_client: AsyncClient):
        value = {"enabled": True, "obico_force": False, "off_delay_seconds": 5000}
        assert (await async_client.put(f"{URL}/camera_led", json=value)).status_code == 422


class TestUpstreamContracts:
    def test_hand_back_is_wrapped(self):
        assert getattr(camera_light.hand_back, "hyyz17200", False) is True

    def test_the_light_route_hands_back_through_the_module(self):
        from backend.app.api.routes import printers

        source = inspect.getsource(printers.set_chamber_light)
        assert "camera_light_service.hand_back(printer_id)" in source

    def test_camera_light_internals(self):
        assert isinstance(camera_light._holders, dict)
        assert isinstance(camera_light._lit_at, dict)
        assert isinstance(camera_light._off_tasks, dict)
        source = inspect.getsource(camera_light._turn_off_later)
        # It only turns off a light it switched on itself (listed in _lit_at).
        assert "_lit_at.pop(printer_id, None) is None" in source
        assert "_holders.get(printer_id)" in source
        assert "client.state.chamber_light" in inspect.getsource(camera_light._acquire)

    def test_the_mqtt_client_switches_the_light(self):
        assert list(inspect.signature(BambuMQTTClient.set_chamber_light).parameters) == ["self", "on"]
        state = PrinterState()
        assert state.chamber_light is False and hasattr(state, "connected") and hasattr(state, "state")

    def test_obico_settings_keys(self):
        from backend.app.services.obico_detection import ObicoDetectionService

        source = inspect.getsource(ObicoDetectionService._load_settings)
        for key in ('"enabled":', '"ml_url":', '"enabled_printers":', "None  # None = all printers"):
            assert key in source

    def test_the_runner_runs_in_the_lifespan(self):
        import backend.app.hyyz17200 as fork

        source = inspect.getsource(fork._wrap_lifespan)
        assert "camera_led.runner.start()" in source and "camera_led.runner.stop()" in source


@pytest.mark.asyncio
async def test_the_light_button_counts_as_the_users(async_client: AsyncClient, printer_factory, monkeypatch):
    from backend.app.services.printer_manager import printer_manager

    printer = await printer_factory()
    client = FakeClient(SimpleNamespace(connected=True, state="RUNNING", chamber_light=True))
    monkeypatch.setattr(printer_manager, "get_client", lambda pid: client if pid == printer.id else None)

    response = await async_client.post(f"/api/v1/printers/{printer.id}/chamber-light?on=false")

    assert response.status_code == 200
    assert client.sent == [False]
    assert printer.id in camera_led._manual_at
