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


class TestProbe:
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
