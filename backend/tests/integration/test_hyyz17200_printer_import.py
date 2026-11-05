"""Bulk printer import: serials read from the IP, upstream's add route without its probe (hyyz17200)."""

import asyncio
import inspect
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.hyyz17200 import printer_import
from backend.app.models.printer import Printer
from backend.app.services.printer_manager import printer_manager

PROBE_URL = "/api/v1/hyyz17200/printers/import/probe"
IMPORT_URL = "/api/v1/hyyz17200/printers/import"


def _row(**overrides) -> dict:
    row = {
        "name": "A1-01",
        "serial_number": "03919C000000001",
        "ip_address": "192.168.1.101",
        "access_code": "12345678",
        "model": "A1",
        "location": "Rack 1",
    }
    row.update(overrides)
    return row


@contextmanager
def _upstream_probe(result: dict):
    """Upstream's probe mocked, with the fork's wrapper on top of the mock."""
    with (
        patch.object(printer_manager, "test_connection", new=AsyncMock(return_value=result)) as probe,
        patch.object(printer_manager, "connect_printer", new=AsyncMock()) as connect,
    ):
        printer_import.install()
        yield probe, connect


class TestImport:
    @pytest.mark.asyncio
    async def test_skips_the_probe_by_default(self, async_client: AsyncClient, db_session):
        with _upstream_probe({"success": False}) as (probe, connect):
            response = await async_client.post(IMPORT_URL, json={"printer": _row(serial_number=" 03919c000000001 ")})

        assert response.status_code == 200, response.text
        assert response.json()["serial_number"] == "03919C000000001"
        probe.assert_not_awaited()
        connect.assert_awaited_once()
        printer = (await db_session.execute(select(Printer))).scalar_one()
        assert (printer.name, printer.location, printer.model) == ("A1-01", "Rack 1", "A1")

    @pytest.mark.asyncio
    async def test_verify_runs_upstreams_probe(self, async_client: AsyncClient, db_session):
        with _upstream_probe({"success": False}) as (probe, _connect):
            response = await async_client.post(IMPORT_URL, json={"printer": _row(), "verify": True})

        assert response.status_code == 400
        assert response.json()["detail"] == "printer_connection_failed"
        probe.assert_awaited_once()
        assert (await db_session.execute(select(Printer))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_duplicate_serial(self, async_client: AsyncClient, printer_factory):
        await printer_factory(serial_number="03919C000000001")
        with _upstream_probe({"success": True}):
            response = await async_client.post(IMPORT_URL, json={"printer": _row()})

        assert response.status_code == 400
        assert response.json()["detail"] == "duplicate_serial"

    @pytest.mark.asyncio
    async def test_the_skip_is_used_once(self):
        """A task the request starts inherits its context; a real probe it runs later must not be skipped."""
        with _upstream_probe({"success": False}) as (probe, _connect):
            token = printer_import._SKIP_PROBE.set({"SERIAL1"})
            try:
                first = await printer_manager.test_connection(ip_address="x", serial_number="SERIAL1", access_code="a")
                second = await printer_manager.test_connection(ip_address="x", serial_number="SERIAL1", access_code="a")
                other = await printer_manager.test_connection("x", "SERIAL2", "a")
            finally:
                printer_import._SKIP_PROBE.reset(token)

        assert first["success"] is True
        assert second == {"success": False}
        assert other == {"success": False}
        assert probe.await_count == 2


# The real one, for the tests of the listen itself.
_LISTEN_SSDP = printer_import.listen_ssdp


@pytest.fixture(autouse=True)
def _no_ssdp_listen():
    """The real listen binds port 2021 and waits up to 10 s."""
    with patch.object(printer_import, "listen_ssdp", new=AsyncMock(return_value={})):
        yield


class TestProbe:
    @pytest.mark.asyncio
    async def test_broadcast_gives_name_and_model(self, async_client: AsyncClient):
        """A1/P1 ignore the unicast query: the serial comes from the certificate,
        the name and model from the printer's SSDP broadcast."""
        with (
            patch.object(
                printer_import,
                "listen_ssdp",
                new=AsyncMock(return_value={"10.0.0.5": ("039199471100344", "A1_001", "N2S")}),
            ),
            patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=(None, None, None))),
            patch.object(printer_import, "read_cert", new=AsyncMock(return_value="039199471100344")),
        ):
            body = (await async_client.post(PROBE_URL, json={"ip_addresses": ["10.0.0.5", "10.0.0.6"]})).json()

        assert body[0] == {
            "ip_address": "10.0.0.5",
            "serial_number": "039199471100344",
            "name": "A1_001",
            "model": "N2S",
            "source": "ssdp",
        }
        assert body[1]["serial_number"] == "039199471100344"  # the cert mock answers every IP
        assert body[1]["source"] == "certificate"

    @pytest.mark.asyncio
    async def test_listen_uses_what_was_heard(self):
        from types import SimpleNamespace

        from backend.app.services import discovery

        heard = [SimpleNamespace(ip_address="10.0.0.5", serial="S1", name="A1", model="N2S")]
        with (
            patch.object(discovery, "is_running_in_docker", return_value=False),
            patch.object(type(discovery.discovery_service), "discovered_printers", new=property(lambda _: heard)),
            patch.object(discovery.discovery_service, "start", new=AsyncMock()) as start,
        ):
            result = await _LISTEN_SSDP(["10.0.0.5"])

        assert result == {"10.0.0.5": ("S1", "A1", "N2S")}
        start.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_listen_in_docker(self):
        from backend.app.services import discovery

        with (
            patch.object(discovery, "is_running_in_docker", return_value=True),
            patch.object(discovery.discovery_service, "start", new=AsyncMock()) as start,
        ):
            assert await _LISTEN_SSDP(["10.0.0.5"]) == {}
        start.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_ssdp_first(self, async_client: AsyncClient):
        with (
            patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=("03919C000000001", "A1-01", "N2S"))),
            patch.object(printer_import, "read_cert", new=AsyncMock()) as cert,
        ):
            response = await async_client.post(PROBE_URL, json={"ip_addresses": ["192.168.1.101"]})

        assert response.status_code == 200
        assert response.json() == [
            {
                "ip_address": "192.168.1.101",
                "serial_number": "03919C000000001",
                "name": "A1-01",
                "model": "N2S",
                "source": "ssdp",
            }
        ]
        cert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_certificate_when_ssdp_is_silent(self, async_client: AsyncClient):
        with (
            patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=(None, None, None))),
            patch.object(printer_import, "read_cert", new=AsyncMock(return_value="01p00a000000001")),
        ):
            response = await async_client.post(PROBE_URL, json={"ip_addresses": ["10.0.0.5", "10.0.0.5", " "]})

        body = response.json()
        assert len(body) == 1
        assert body[0]["serial_number"] == "01P00A000000001"
        assert body[0]["source"] == "certificate"

    @pytest.mark.asyncio
    async def test_nothing_answers(self, async_client: AsyncClient):
        with (
            patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=(None, None, None))),
            patch.object(printer_import, "read_cert", new=AsyncMock(return_value="not a serial!")),
        ):
            body = (await async_client.post(PROBE_URL, json={"ip_addresses": ["10.0.0.5"]})).json()

        assert body[0]["serial_number"] is None
        assert body[0]["source"] is None

    @pytest.mark.asyncio
    async def test_bambuddys_virtual_printer_is_left_out(self):
        with patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=("0000000391800001", "VP", "C12"))):
            result = await printer_import.probe_ip("10.0.0.9")
        assert result["serial_number"] is None
        assert result["source"] == "virtual"

    @pytest.mark.asyncio
    async def test_reads_the_certificate_cn(self):
        """A real TLS server on a local port, presenting a cert whose CN is the serial."""
        import datetime
        import ssl
        import tempfile
        from pathlib import Path

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID

        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "01P00A000000001")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(1)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .sign(key, hashes.SHA256())
        )
        with tempfile.TemporaryDirectory() as tmp:
            cert_path, key_path = Path(tmp) / "c.pem", Path(tmp) / "k.pem"
            cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            key_path.write_bytes(
                key.private_bytes(
                    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
                )
            )
            server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_ctx.load_cert_chain(cert_path, key_path)

        async def handle(reader, writer):
            try:
                await reader.read()
            except Exception:
                pass
            writer.close()

        server = await asyncio.start_server(handle, "127.0.0.1", 0, ssl=server_ctx)
        port = server.sockets[0].getsockname()[1]
        try:
            with patch.object(printer_import, "MQTT_PORT", port):
                assert await printer_import.read_cert("127.0.0.1") == "01P00A000000001"
        finally:
            server.close()


class TestUpstreamContracts:
    def test_the_discovery_listener_is_still_there(self):
        from backend.app.services.discovery import discovery_service

        assert inspect.iscoroutinefunction(discovery_service.start)
        assert list(inspect.signature(discovery_service.start).parameters) == ["duration"]
        assert isinstance(discovery_service.is_running, bool)

    def test_the_wrapper_is_installed(self):
        assert getattr(printer_manager.test_connection, "hyyz17200", False) is True

    def test_create_printer_still_probes_through_the_manager(self):
        from backend.app.api.routes import printers

        source = inspect.getsource(printers.create_printer)
        assert "printer_manager.test_connection(" in source
        assert "serial_number=printer_data.serial_number" in source
        assert set(inspect.signature(printers.create_printer).parameters) == {"printer_data", "_", "db"}

    def test_the_ssdp_query_is_still_there(self):
        from backend.app.services.discovery import SubnetScanner

        assert list(inspect.signature(SubnetScanner._get_printer_info_ssdp).parameters) == ["self", "ip", "timeout"]


SCAN_URL = "/api/v1/hyyz17200/printers/scan"


@pytest.fixture
def _fresh_scan():
    from backend.app.hyyz17200 import printer_scan

    printer_scan.shutdown()
    printer_scan._scan = None
    yield printer_scan
    printer_scan.shutdown()
    printer_scan._scan = None


class TestScan:
    def test_subnet_limits(self):
        from backend.app.hyyz17200 import printer_scan

        assert printer_scan.parse_subnet("192.168.5.7/20").num_addresses == 4096
        assert printer_scan.parse_subnet("10.1.0.0/16").num_addresses == 65536
        for bad, code in (
            ("10.0.0.0/15", "subnet_too_large"),
            ("nonsense", "invalid_subnet"),
            ("fe80::/120", "invalid_subnet"),
        ):
            with pytest.raises(printer_scan.ScanError, match=code):
                printer_scan.parse_subnet(bad)

    @pytest.mark.asyncio
    async def test_a_printer_is_upstreams_two_open_ports(self):
        from backend.app.hyyz17200 import printer_scan

        def ports(open_ports):
            return patch.object(printer_scan, "_port_open", new=AsyncMock(side_effect=lambda ip, port: port in open_ports))

        def sources(ssdp=(None, None, None), cert=None):
            return (
                patch.object(printer_import, "read_ssdp", new=AsyncMock(return_value=ssdp)),
                patch.object(printer_import, "read_cert", new=AsyncMock(return_value=cert)),
            )

        a, b = sources(cert="039199471100344")
        with a, b:
            with ports({8883, 990}):
                assert await printer_scan.check_host("10.0.0.1") == ("039199471100344", None, None)
            for open_ports in ({8883}, {990}, set()):
                with ports(open_ports):
                    assert await printer_scan.check_host("10.0.0.1") is None
        # Upstream's unicast answer first, the certificate not read then.
        a, b = sources(ssdp=("0948AB000000001", "H2D-01", "O1D"))
        with a, b as cert, ports({8883, 990}):
            assert await printer_scan.check_host("10.0.0.1") == ("0948AB000000001", "H2D-01", "O1D")
            cert.assert_not_awaited()
        # Neither names a serial: still a printer, as upstream lists it.
        a, b = sources(cert="some other CN")
        with a, b, ports({8883, 990}):
            assert await printer_scan.check_host("10.0.0.1") == (None, None, None)
        a, b = sources(ssdp=("0000000391800001", "VP", "C12"))
        with a, b, ports({8883, 990}):
            assert await printer_scan.check_host("10.0.0.1") is None

    @pytest.mark.asyncio
    async def test_scan_over_the_api(self, async_client: AsyncClient, _fresh_scan):
        from types import SimpleNamespace

        from backend.app.services import discovery

        printers = {
            "10.0.0.5": ("039199471100344", None, None),
            "10.0.0.3": ("22E8BJ5A2101411", None, None),
            "10.0.0.7": (None, None, None),
            "10.0.0.9": (None, None, None),
            "10.0.0.2": ("0948AB000000001", "H2D-01", "O1D"),
        }
        heard = [
            SimpleNamespace(ip_address="10.0.0.3", serial="22E8BJ5A2101411", name="NoNo-P2S", model="N7"),
            SimpleNamespace(ip_address="10.0.0.7", serial="03919C000000007", name="A1-07", model="N2S"),
        ]
        with (
            patch.object(_fresh_scan, "check_host", new=AsyncMock(side_effect=lambda ip: printers.get(ip))),
            patch.object(_fresh_scan, "_listen", new=AsyncMock()),
            patch.object(type(discovery.discovery_service), "discovered_printers", new=property(lambda _: heard)),
        ):
            started = await async_client.post(SCAN_URL, json={"subnet": "10.0.0.0/28"})
            assert started.status_code == 200
            assert started.json()["total"] == 14
            for _ in range(100):
                state = (await async_client.get(SCAN_URL)).json()
                if not state["running"]:
                    break
                await asyncio.sleep(0.01)

        assert state["scanned"] == 14
        assert state["printers"] == [
            {"ip_address": "10.0.0.2", "serial_number": "0948AB000000001", "name": "H2D-01", "model": "O1D"},
            {"ip_address": "10.0.0.3", "serial_number": "22E8BJ5A2101411", "name": "NoNo-P2S", "model": "N7"},
            {"ip_address": "10.0.0.5", "serial_number": "039199471100344", "name": None, "model": None},
            {"ip_address": "10.0.0.7", "serial_number": "03919C000000007", "name": "A1-07", "model": "N2S"},
            {"ip_address": "10.0.0.9", "serial_number": None, "name": None, "model": None},
        ]

    @pytest.mark.asyncio
    async def test_too_large(self, async_client: AsyncClient, _fresh_scan):
        response = await async_client.post(SCAN_URL, json={"subnet": "10.0.0.0/8"})
        assert response.status_code == 400
        assert response.json()["detail"] == "subnet_too_large"

    @pytest.mark.asyncio
    async def test_stop(self, async_client: AsyncClient, _fresh_scan):
        gate = asyncio.Event()

        async def slow(ip):
            await gate.wait()

        with patch.object(_fresh_scan, "check_host", new=slow), patch.object(_fresh_scan, "_listen", new=AsyncMock()):
            await async_client.post(SCAN_URL, json={"subnet": "10.0.0.0/24"})
            again = await async_client.post(SCAN_URL, json={"subnet": "10.0.0.0/24"})
            assert again.status_code == 409
            assert again.json()["detail"] == "scan_running"
            stopped = (await async_client.post(f"{SCAN_URL}/stop")).json()
            gate.set()
        assert stopped["running"] is False
