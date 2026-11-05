"""Bulk printer import (see .claude/rules/hyyz17200-fork.md, "批量添加打印机").

Two things upstream's Add Printer dialog does that a list of printers needs too:

* Read the serial number from the IP, so it never has to be copied off the
  printer. The printer answers a unicast SSDP query with its serial, name and
  model -- the same query upstream's subnet scan sends. Some printers or
  networks do not answer it; the MQTT port's TLS certificate names the serial
  as well (subject CN), and reading it needs no access code.
* Add each printer through upstream's own ``POST /printers/`` route, optionally
  without the MQTT probe it runs first. The probe is a full TLS + MQTT
  connection to the printer (seconds each, more on P1 firmware); the printer is
  connected right after it is saved anyway, and the import page shows whether
  that connection came up.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import re
import ssl

logger = logging.getLogger(__name__)

MQTT_PORT = 8883
SSDP_TIMEOUT_SECONDS = 2.0
CERT_TIMEOUT_SECONDS = 5.0
MAX_CONCURRENT_PROBES = 8
MAX_IPS = 500

# Bambu serials are 15 uppercase alphanumerics today; a little slack either way.
_SERIAL_RE = re.compile(r"^[0-9A-Z]{8,20}$")

# The serial numbers whose next upstream connection probe is skipped. Set per
# request; each entry is used once, so a task the request starts (the printer's
# MQTT client inherits the context) never skips a later, real probe.
_SKIP_PROBE: contextvars.ContextVar[set[str] | None] = contextvars.ContextVar("hyyz17200_skip_probe", default=None)


def _valid_serial(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().upper()
    return value if _SERIAL_RE.match(value) else None


async def read_ssdp(ip: str) -> tuple[str | None, str | None, str | None]:
    """(serial, name, model code) from the printer's SSDP answer, else Nones."""
    from backend.app.services.discovery import SubnetScanner

    try:
        return await SubnetScanner()._get_printer_info_ssdp(ip, SSDP_TIMEOUT_SECONDS)
    except Exception:
        logger.debug("SSDP query to %s failed", ip, exc_info=True)
        return None, None, None


def _cert_common_name(der: bytes) -> str | None:
    from cryptography import x509
    from cryptography.x509.oid import NameOID

    cert = x509.load_der_x509_certificate(der)
    names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(names[0].value) if names else None


async def read_cert(ip: str) -> str | None:
    """The subject CN of the certificate on the printer's MQTT port."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    writer = None
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, MQTT_PORT, ssl=context), timeout=CERT_TIMEOUT_SECONDS
        )
        ssl_object = writer.get_extra_info("ssl_object")
        der = ssl_object.getpeercert(binary_form=True) if ssl_object else None
        return _cert_common_name(der) if der else None
    except Exception:
        logger.debug("Could not read the MQTT certificate of %s", ip, exc_info=True)
        return None
    finally:
        if writer is not None:
            # abort, not close: a printer can sit on the TLS close handshake
            # (the same stall bambu_ftp's uploads hit), and nothing is sent.
            writer.transport.abort()


async def probe_ip(ip: str) -> dict:
    """What the printer at ``ip`` says about itself. ``serial`` is None when
    neither source answered; ``source`` says which one did."""
    from backend.app.services.discovery import VIRTUAL_PRINTER_SERIAL_SUFFIX

    serial, name, model = await read_ssdp(ip)
    source = "ssdp"
    serial = _valid_serial(serial)
    if serial is None:
        serial = _valid_serial(await read_cert(ip))
        source = "certificate"
    if serial is None:
        return {"ip_address": ip, "serial_number": None, "name": name, "model": model, "source": None}
    if serial.endswith(VIRTUAL_PRINTER_SERIAL_SUFFIX):
        # Bambuddy's own virtual printer; upstream's discovery hides it too.
        return {"ip_address": ip, "serial_number": None, "name": name, "model": model, "source": "virtual"}
    return {"ip_address": ip, "serial_number": serial, "name": name, "model": model, "source": source}


async def probe_ips(ips: list[str]) -> list[dict]:
    """``probe_ip`` for each address, a few at a time, in the given order."""
    slots = asyncio.Semaphore(MAX_CONCURRENT_PROBES)
    unique = list(dict.fromkeys(ip.strip() for ip in ips if ip.strip()))

    async def one(ip: str) -> dict:
        async with slots:
            return await probe_ip(ip)

    return list(await asyncio.gather(*(one(ip) for ip in unique)))


def install() -> None:
    """Let a request skip upstream's connection probe for chosen serials. Safe
    to call more than once."""
    from backend.app.services.printer_manager import printer_manager

    upstream = printer_manager.test_connection
    if getattr(upstream, "hyyz17200", False) is True:
        return

    async def test_connection(*args, **kwargs):
        skip = _SKIP_PROBE.get()
        serial = kwargs.get("serial_number", args[1] if len(args) > 1 else None)
        if skip and serial in skip:
            skip.discard(serial)
            return {"success": True, "state": None, "model": None, "reason": None}
        return await upstream(*args, **kwargs)

    test_connection.hyyz17200 = True  # type: ignore[attr-defined]
    test_connection.upstream = upstream  # type: ignore[attr-defined]
    printer_manager.test_connection = test_connection


async def add_printer(printer_data, db, *, verify: bool):
    """Upstream's ``create_printer``, without its probe unless ``verify``."""
    from backend.app.api.routes import printers as printers_routes

    token = _SKIP_PROBE.set(None if verify else {printer_data.serial_number})
    try:
        return await printers_routes.create_printer(printer_data, _=None, db=db)
    finally:
        _SKIP_PROBE.reset(token)
