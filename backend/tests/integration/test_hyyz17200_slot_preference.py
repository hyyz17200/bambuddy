"""Slot preference: among identical spools, the loaded slot, else the last loaded (hyyz17200)."""

import inspect
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import backend.app.hyyz17200.models  # noqa: F401 - the fork's tables
from backend.app.hyyz17200 import slot_preference
from backend.app.hyyz17200.models import PrinterLastTray
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.print_scheduler import PrintScheduler

YELLOW = {"tray_type": "PETG", "tray_color": "F6DA5AFF", "tray_info_idx": "GFG00"}
BLACK = {"tray_type": "PETG", "tray_color": "000000FF", "tray_info_idx": "GFG00"}


def _state(trays: dict[int, dict], tray_now: int = 255, last_loaded: int = -1, backup: bool | None = True):
    state = PrinterState()
    state.connected = True
    state.state = "IDLE"
    state.raw_data = {
        "ams": [{"id": "0", "tray": [{"id": str(i), **trays[i]} if i in trays else {"id": str(i)} for i in range(4)]}]
    }
    state.tray_now = tray_now
    state.last_loaded_tray = last_loaded
    state.ams_filament_backup = backup
    return state


def _item(mapping: list | None = None):
    return SimpleNamespace(
        id=1,
        filament_overrides=None,
        created_by_id=None,
        ams_mapping=json.dumps(mapping) if mapping is not None else None,
    )


def _req(slot_id: int, color: str = "#F6DA5A") -> dict:
    return {"slot_id": slot_id, "type": "PETG", "color": color, "tray_info_idx": "GFG00"}


@pytest.fixture
def enabled():
    slot_preference.apply_settings(slot_preference.SlotPreferenceSettings(enabled=True))
    yield
    slot_preference.apply_settings(slot_preference.SlotPreferenceSettings())


@pytest.fixture
def scheduler():
    """A scheduler of its own with the wrappers on, in place of the app's."""
    instance = PrintScheduler()
    with patch("backend.app.services.print_scheduler.scheduler", instance):
        slot_preference.install()
        yield instance


def _printer(state):
    return (
        patch("backend.app.services.print_scheduler.printer_manager.get_status", return_value=state),
        patch.object(slot_preference.printer_manager, "get_status", return_value=state),
    )


async def _compute(scheduler, db, state, reqs, *, prefer_lowest=False, **kwargs):
    a, b = _printer(state)
    with (
        a,
        b,
        patch.object(scheduler, "_get_filament_requirements", AsyncMock(return_value=reqs)),
        patch.object(scheduler, "_get_bool_setting", AsyncMock(return_value=prefer_lowest)),
    ):
        return await scheduler._compute_ams_mapping_for_printer(db, 1, _item(), **kwargs)


class TestPrefer:
    def _loaded(self, state):
        return PrintScheduler()._build_loaded_filaments(state)

    def test_moves_to_the_same_spool(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW}))
        assert slot_preference.prefer([0], loaded, 1) == [1]

    def test_never_to_another_colour(self):
        loaded = self._loaded(_state({0: YELLOW, 1: BLACK}))
        assert slot_preference.prefer([0], loaded, 1) is None

    def test_never_to_another_preset(self):
        loaded = self._loaded(_state({0: YELLOW, 1: {**YELLOW, "tray_info_idx": "GFG99"}}))
        assert slot_preference.prefer([0], loaded, 1) is None

    def test_never_to_an_empty_slot(self):
        loaded = self._loaded(_state({0: YELLOW}))
        assert slot_preference.prefer([0], loaded, 1) is None

    def test_a_tray_already_in_the_mapping_stays(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW}))
        assert slot_preference.prefer([0, 1], loaded, 1) is None

    def test_a_reserved_tray_is_left(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW}))
        assert slot_preference.prefer([0, -1], loaded, 1, reserved={1}) is None

    def test_only_one_slot_moves(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW, 2: YELLOW}))
        assert slot_preference.prefer([0, 1], loaded, 2) == [2, 1]

    def test_external_and_nothing_loaded_are_not_slots(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW}))
        assert slot_preference.prefer([0], loaded, 254) is None
        assert slot_preference.prefer([0], loaded, 255) is None
        assert slot_preference.prefer([0], loaded, None) is None

    def test_unresolved_and_odd_entries_are_skipped(self):
        loaded = self._loaded(_state({0: YELLOW, 1: YELLOW}))
        assert slot_preference.prefer([-1, True, 0], loaded, 1) == [-1, True, 1]


class TestPreferredTray:
    @pytest.mark.asyncio
    async def test_the_loaded_slot_first(self, db_session):
        state = _state({}, tray_now=2, last_loaded=1)
        assert await slot_preference.preferred_tray(db_session, 1, state) == (2, "loaded")

    @pytest.mark.asyncio
    async def test_then_the_last_loaded(self, db_session):
        state = _state({}, tray_now=255, last_loaded=1)
        assert await slot_preference.preferred_tray(db_session, 1, state) == (1, "last loaded")

    @pytest.mark.asyncio
    async def test_then_the_stored_one(self, db_session, printer_factory):
        printer = await printer_factory()
        db_session.add(PrinterLastTray(printer_id=printer.id, tray=3))
        await db_session.commit()
        state = _state({}, tray_now=255, last_loaded=-1)
        assert await slot_preference.preferred_tray(db_session, printer.id, state) == (
            3,
            "last loaded before a restart",
        )

    @pytest.mark.asyncio
    async def test_the_external_spool_does_not_count(self, db_session):
        state = _state({}, tray_now=254, last_loaded=254)
        assert await slot_preference.preferred_tray(db_session, 1, state) == (None, "")


class TestComputedMapping:
    @pytest.mark.asyncio
    async def test_upstream_takes_the_lower_slot(self, db_session, scheduler):
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        assert await _compute(scheduler, db_session, state, [_req(1)]) == [0]

    @pytest.mark.asyncio
    async def test_the_loaded_slot_is_used(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        assert await _compute(scheduler, db_session, state, [_req(1)]) == [1]

    @pytest.mark.asyncio
    async def test_after_an_unload_the_last_loaded_slot(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW, 2: YELLOW}, tray_now=255, last_loaded=2)
        assert await _compute(scheduler, db_session, state, [_req(1)]) == [2]

    @pytest.mark.asyncio
    async def test_a_different_filament_loaded_changes_nothing(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW, 2: BLACK}, tray_now=2)
        assert await _compute(scheduler, db_session, state, [_req(1)]) == [0]

    @pytest.mark.asyncio
    async def test_a_multicolour_job_keeps_its_other_slots(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: BLACK, 2: YELLOW}, tray_now=2)
        reqs = [_req(1), _req(2, color="#000000")]
        assert await _compute(scheduler, db_session, state, reqs) == [2, 1]

    @pytest.mark.asyncio
    async def test_prefer_lowest_remaining_decides_instead(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        assert await _compute(scheduler, db_session, state, [_req(1)], prefer_lowest=True) == [0]

    @pytest.mark.asyncio
    async def test_unless_backup_is_off_where_upstream_ignores_it(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1, backup=False)
        assert await _compute(scheduler, db_session, state, [_req(1)], prefer_lowest=True) == [1]

    @pytest.mark.asyncio
    async def test_a_gap_fill_leaves_the_reserved_trays(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW, 2: YELLOW}, tray_now=1)
        mapping = await _compute(scheduler, db_session, state, [_req(1), _req(2)], only_slots={2}, reserved_trays={1})
        assert mapping == [-1, 0]

    @pytest.mark.asyncio
    async def test_an_error_keeps_upstreams_mapping(self, db_session, scheduler, enabled):
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        with patch.object(slot_preference, "preferred_tray", AsyncMock(side_effect=RuntimeError("boom"))):
            assert await _compute(scheduler, db_session, state, [_req(1)]) == [0]


class TestStoredMapping:
    @pytest.mark.asyncio
    async def test_a_stored_mapping_moves_to_the_loaded_slot(self, db_session, enabled):
        instance = PrintScheduler()
        instance._settle_ams_mapping = AsyncMock(return_value=None)
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        item = _item([0])
        a, b = _printer(state)
        with patch("backend.app.services.print_scheduler.scheduler", instance), a, b:
            slot_preference.install()
            with patch.object(instance, "_get_bool_setting", AsyncMock(return_value=False)):
                assert await instance._settle_ams_mapping(db_session, 1, item) is None
        assert json.loads(item.ams_mapping) == [1]

    @pytest.mark.asyncio
    async def test_a_refused_mapping_is_left_alone(self, db_session, enabled):
        instance = PrintScheduler()
        instance._settle_ams_mapping = AsyncMock(return_value="cannot print")
        state = _state({0: YELLOW, 1: YELLOW}, tray_now=1)
        item = _item([0])
        a, b = _printer(state)
        with patch("backend.app.services.print_scheduler.scheduler", instance), a, b:
            slot_preference.install()
            assert await instance._settle_ams_mapping(db_session, 1, item) == "cannot print"
        assert json.loads(item.ams_mapping) == [0]


class TestRecord:
    @pytest.mark.asyncio
    async def test_writes_changes_only(self, db_session, test_engine, printer_factory, enabled, monkeypatch):
        monkeypatch.setattr(
            slot_preference.database,
            "async_session",
            async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False),
        )
        monkeypatch.setattr(slot_preference, "_written", {})
        a = (await printer_factory()).id
        b = (await printer_factory()).id
        statuses = {
            a: _state({}, last_loaded=1),
            b: _state({}, last_loaded=-1),
            9999: _state({}, last_loaded=2),  # no such printer
        }
        with patch.object(slot_preference.printer_manager, "get_all_statuses", return_value=statuses):
            await slot_preference.record()
            assert slot_preference._written == {a: 1}
            statuses[a].last_loaded_tray = 3
            await slot_preference.record()

        db_session.expire_all()
        assert (await db_session.get(PrinterLastTray, a)).tray == 3
        assert await db_session.get(PrinterLastTray, b) is None
        assert await db_session.get(PrinterLastTray, 9999) is None

    @pytest.mark.asyncio
    async def test_nothing_while_off(self, monkeypatch):
        statuses = {1: _state({}, last_loaded=1)}
        with patch.object(slot_preference.printer_manager, "get_all_statuses", return_value=statuses) as read:
            await slot_preference.record()
        read.assert_not_called()

    @pytest.mark.asyncio
    async def test_deleting_the_printer_drops_its_row(self, db_session, printer_factory):
        printer = await printer_factory()
        db_session.add(PrinterLastTray(printer_id=printer.id, tray=1))
        await db_session.commit()
        await db_session.delete(printer)
        await db_session.commit()
        assert await db_session.get(PrinterLastTray, printer.id) is None


class TestSettings:
    @pytest.mark.asyncio
    async def test_it_is_an_enhanced_setting_and_off_by_default(self, async_client):
        settings = (await async_client.get("/api/v1/hyyz17200/settings")).json()
        assert settings["slot_preference"] == {"enabled": False}

    @pytest.mark.asyncio
    async def test_saving_turns_it_on(self, async_client):
        try:
            response = await async_client.put("/api/v1/hyyz17200/settings/slot_preference", json={"enabled": True})
            assert response.status_code == 200
            assert slot_preference.is_enabled() is True
        finally:
            slot_preference.apply_settings(slot_preference.SlotPreferenceSettings())


class TestUpstreamContracts:
    """What this patch borrows from upstream. A rename fails here, not on a printer."""

    def test_the_wrappers_are_installed(self):
        from backend.app.main import app  # noqa: F401 - register() runs on import
        from backend.app.services.print_scheduler import scheduler

        assert getattr(scheduler._compute_ams_mapping_for_printer, "hyyz17200", False) is True
        assert getattr(scheduler._settle_ams_mapping, "hyyz17200", False) is True

    def test_the_wrapped_methods(self):
        compute = inspect.signature(PrintScheduler._compute_ams_mapping_for_printer).parameters
        assert list(compute)[:4] == ["self", "db", "printer_id", "item"]
        assert compute["reserved_trays"].kind is inspect.Parameter.KEYWORD_ONLY
        assert list(inspect.signature(PrintScheduler._settle_ams_mapping).parameters) == [
            "self",
            "db",
            "printer_id",
            "item",
        ]

    def test_they_are_called_through_the_instance(self):
        """A call through the class, or a renamed method, would bypass the wrappers."""
        assert "self._settle_ams_mapping(" in inspect.getsource(PrintScheduler._ensure_ams_mapping)
        assert "self._compute_ams_mapping_for_printer(" in inspect.getsource(PrintScheduler._settle_ams_mapping)

    def test_the_state_it_reads(self):
        state = PrinterState()
        assert state.last_loaded_tray == -1
        assert hasattr(state, "tray_now")
        assert hasattr(state, "ams_filament_backup")
        assert callable(PrintScheduler._get_bool_setting)

    def test_the_loaded_filaments_it_compares(self):
        loaded = PrintScheduler()._build_loaded_filaments(_state({0: YELLOW}))
        assert {"type", "color", "color_known", "tray_info_idx", "global_tray_id", "extruder_id", "is_external"} <= set(
            loaded[0]
        )
