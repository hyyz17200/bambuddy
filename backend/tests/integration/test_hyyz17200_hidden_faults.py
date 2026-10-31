"""Hidden fault codes: stored, cached, and left out of alerts only (upstream #3269)."""

import inspect
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

from backend.app import main
from backend.app.hyyz17200.hms_filter import is_hidden_code, normalize_code, set_hidden_codes, visible_faults
from backend.app.hyyz17200.migrations import run_migrations
from backend.app.hyyz17200.models import HiddenFault  # noqa: F401  (create_all needs the table)
from backend.app.services.bambu_mqtt import HMSError, PrinterState
from backend.app.services.notify_live_activities import _printer_fault
from backend.app.services.printer_manager import printer_state_to_dict

BMCU_A = "0500040000010044"
BUSY = "05004004"
URL = "/api/v1/hyyz17200/hidden-faults"


def _fault(full_code: str, description: str = "Some fault") -> HMSError:
    return HMSError(code="0x0", attr=0, module=5, severity=1, full_code=full_code, description=description)


@pytest.fixture(autouse=True)
def _no_hidden_codes():
    set_hidden_codes([])
    yield
    set_hidden_codes([])


class TestMatching:
    @pytest.mark.parametrize(
        "raw",
        ["0500_0400_0001_0044", "0500-0400-0001-0044", "0x0500040000010044", " 0500 0400 0001 0044 ", BMCU_A.lower()],
    )
    def test_normalize_accepts_the_written_forms(self, raw):
        assert normalize_code(raw) == BMCU_A

    @pytest.mark.parametrize("raw", ["", "0500", "05000400000100", "GGGG4004", "0500040000010044FF"])
    def test_normalize_rejects_other_lengths_and_non_hex(self, raw):
        with pytest.raises(ValueError):
            normalize_code(raw)

    def test_a_16_digit_entry_is_exact(self):
        set_hidden_codes([BMCU_A])
        assert is_hidden_code(BMCU_A)
        assert is_hidden_code(BMCU_A.lower())
        assert not is_hidden_code("0501040000010044")
        assert not is_hidden_code("05000044")

    def test_an_8_digit_entry_also_covers_the_hms_form(self):
        # The parser drops a print_error already in hms[], so this is the only
        # form the fault may arrive in.
        set_hidden_codes([BUSY])
        assert is_hidden_code(BUSY)
        assert is_hidden_code("0500030000024004")
        assert not is_hidden_code("0500030000024005")
        assert not is_hidden_code("0501030000024004")

    def test_nothing_is_hidden_by_default(self):
        assert not is_hidden_code(BMCU_A)
        assert not is_hidden_code(None)
        assert not is_hidden_code("")

    def test_visible_faults_leaves_its_input_alone(self):
        set_hidden_codes([BMCU_A])
        real = _fault("0700700000020001")
        errors = [_fault(BMCU_A), real]

        assert visible_faults(errors) == [real]
        assert len(errors) == 2
        assert visible_faults(None) == []


class TestSurfaces:
    def test_live_activity_skips_a_hidden_fault_and_reports_the_next(self):
        set_hidden_codes([BMCU_A])
        state = SimpleNamespace(hms_errors=[_fault(BMCU_A, "AMS firmware"), _fault("0700700000020001", "Real fault")])

        assert _printer_fault(state) == "Real fault"

    def test_live_activity_has_no_fault_when_only_hidden_ones_remain(self):
        set_hidden_codes([BMCU_A])

        assert _printer_fault(SimpleNamespace(hms_errors=[_fault(BMCU_A)])) is None

    def test_the_websocket_payload_keeps_every_fault(self):
        set_hidden_codes([BMCU_A])
        state = PrinterState(connected=True, state="IDLE", hms_errors=[_fault(BMCU_A)])

        payload = printer_state_to_dict(state)

        assert [e["full_code"] for e in payload["hms_errors"]] == [BMCU_A]

    def test_a_hidden_fault_sends_no_alert_and_stays_in_the_dedup_record(self):
        """The mount in main.py's status callback: alerts go, the record stays."""
        source = inspect.getsource(main)
        take = "new_errors = _take_new_hms_faults(printer_id, current_hms_errors, state.state)"
        assert (
            source.replace("\r\n", "\n").count(f"{take}\n        new_errors = hyyz17200_visible_faults(new_errors)")
            == 1
        )

        set_hidden_codes([BMCU_A])
        fault = _fault(BMCU_A)
        printer_id = 987654
        try:
            assert main.hyyz17200_visible_faults(main._take_new_hms_faults(printer_id, [fault], "IDLE")) == []
            assert BMCU_A in main._notified_hms_errors[printer_id]

            # Un-hiding while the fault is still held must not re-alert it.
            set_hidden_codes([])
            assert main.hyyz17200_visible_faults(main._take_new_hms_faults(printer_id, [fault], "IDLE")) == []
        finally:
            main._notified_hms_errors.pop(printer_id, None)
            main._hms_print_state.pop(printer_id, None)
            main._hms_forget_when_gone.pop(printer_id, None)


class TestApi:
    @pytest.mark.asyncio
    async def test_add_normalizes_and_updates_the_cache(self, async_client: AsyncClient):
        response = await async_client.post(URL, json={"code": "0500_0400_0001_0044", "note": "BMCU"})

        assert response.status_code == 200
        assert response.json() == {"code": BMCU_A, "note": "BMCU"}
        assert is_hidden_code(BMCU_A)
        assert (await async_client.get(URL)).json() == [{"code": BMCU_A, "note": "BMCU"}]

    @pytest.mark.asyncio
    async def test_adding_a_listed_code_replaces_its_note(self, async_client: AsyncClient):
        await async_client.post(URL, json={"code": BMCU_A, "note": "old"})
        await async_client.post(URL, json={"code": BMCU_A.lower(), "note": "new"})

        assert (await async_client.get(URL)).json() == [{"code": BMCU_A, "note": "new"}]

    @pytest.mark.asyncio
    async def test_an_invalid_code_is_refused(self, async_client: AsyncClient):
        assert (await async_client.post(URL, json={"code": "nope"})).status_code == 422
        assert (await async_client.delete(f"{URL}/nope")).status_code == 422

    @pytest.mark.asyncio
    async def test_remove_updates_the_cache(self, async_client: AsyncClient):
        await async_client.post(URL, json={"code": BMCU_A})

        assert (await async_client.delete(f"{URL}/{BMCU_A}")).status_code == 204
        assert not is_hidden_code(BMCU_A)
        assert (await async_client.get(URL)).json() == []
        assert (await async_client.delete(f"{URL}/{BMCU_A}")).status_code == 404

    @pytest.mark.asyncio
    async def test_the_migration_step_fills_the_cache(self, async_client: AsyncClient, test_engine):
        """What init_db() runs at startup and after a backup restore."""
        await async_client.post(URL, json={"code": BUSY})
        set_hidden_codes([])

        async with test_engine.connect() as conn:
            await run_migrations(conn)

        assert is_hidden_code(BUSY)
