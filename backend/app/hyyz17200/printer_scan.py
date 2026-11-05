"""Subnet scan for the bulk import page (see .claude/rules/hyyz17200-fork.md, "批量添加打印机").

Upstream's scan (``SubnetScanner``) stops at 1024 addresses and probes 50 at a
time: a /20 is cut off, and a /16 would take over 20 minutes even without the
cap. This one takes up to a /16, many addresses at a time. What counts as a
printer is upstream's rule: FTPS (990) and MQTT (8883) both open. The serial,
name and model come from upstream's unicast SSDP query, then the MQTT
certificate's CN, then the printers' SSDP broadcasts; a printer none of them
names is still listed, without a serial, as upstream lists it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
from dataclasses import dataclass, field

from backend.app.hyyz17200 import printer_import

logger = logging.getLogger(__name__)

MIN_PREFIX = 16  # 65 534 addresses
CONCURRENCY = 256
CONNECT_TIMEOUT_SECONDS = 1.0  # upstream's
FTPS_PORT = 990
SSDP_LISTEN_SECONDS = 20.0


class ScanError(ValueError):
    """The subnet cannot be scanned; the message is a stable code for the UI."""


Found = tuple[str | None, str | None, str | None]  # serial, name, model code


@dataclass
class Scan:
    subnet: str
    total: int
    scanned: int = 0
    running: bool = True
    found: dict[str, Found] = field(default_factory=dict)


_scan: Scan | None = None
_task: asyncio.Task | None = None


def parse_subnet(subnet: str) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.ip_network(subnet.strip(), strict=False)
    except ValueError as exc:
        raise ScanError("invalid_subnet") from exc
    if not isinstance(network, ipaddress.IPv4Network):
        raise ScanError("invalid_subnet")
    if network.prefixlen < MIN_PREFIX:
        raise ScanError("subnet_too_large")
    return network


async def _port_open(ip: str, port: int) -> bool:
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=CONNECT_TIMEOUT_SECONDS)
    except Exception:
        return False
    writer.transport.abort()
    return True


async def check_host(ip: str) -> Found | None:
    """(serial, name, model) of the Bambu printer at ``ip``, else None.

    Upstream's ``SubnetScanner._probe_host`` rule: 990 open, then 8883 open.
    Bambuddy's own virtual printer is skipped, as upstream skips it."""
    if not await _port_open(ip, FTPS_PORT) or not await _port_open(ip, printer_import.MQTT_PORT):
        return None
    from backend.app.services.discovery import VIRTUAL_PRINTER_SERIAL_SUFFIX

    serial, name, model = await printer_import.read_ssdp(ip)
    serial = printer_import._valid_serial(serial)
    if serial is None:
        serial = printer_import._valid_serial(await printer_import.read_cert(ip))
    if serial and serial.endswith(VIRTUAL_PRINTER_SERIAL_SUFFIX):
        return None
    return serial, name, model


async def _run(scan: Scan, hosts) -> None:
    addresses = iter(hosts)

    async def worker() -> None:
        while scan.running:
            ip = next(addresses, None)
            if ip is None:
                return
            ip = str(ip)
            try:
                found = await check_host(ip)
            except Exception:
                logger.debug("Scan probe of %s failed", ip, exc_info=True)
                found = None
            if found is not None:
                scan.found[ip] = found
            scan.scanned += 1

    try:
        await asyncio.gather(*(worker() for _ in range(min(CONCURRENCY, scan.total))))
        logger.info("hyyz17200 scan of %s: %d printers in %d addresses", scan.subnet, len(scan.found), scan.scanned)
    finally:
        scan.running = False


async def _listen() -> None:
    """Start upstream's SSDP listener, which fills its cache with names and models."""
    from backend.app.services.discovery import discovery_service, is_running_in_docker

    if is_running_in_docker() or discovery_service.is_running:
        return
    try:
        await discovery_service.start(SSDP_LISTEN_SECONDS)
    except Exception:
        logger.debug("Could not start the SSDP listener", exc_info=True)


async def start(subnet: str) -> Scan:
    """Start scanning ``subnet`` in the background. One scan at a time."""
    global _scan, _task
    network = parse_subnet(subnet)
    if _scan is not None and _scan.running:
        raise ScanError("scan_running")
    hosts = list(network.hosts()) or list(network)  # a /31 or /32 has no "hosts"
    _scan = Scan(subnet=str(network), total=len(hosts))
    await _listen()
    _task = asyncio.create_task(_run(_scan, hosts))
    return _scan


def stop() -> Scan | None:
    if _scan is not None:
        _scan.running = False
    return _scan


def shutdown() -> None:
    stop()
    if _task is not None and not _task.done():
        _task.cancel()


def serialize(scan: Scan | None) -> dict:
    """The scan's state. A printer's SSDP broadcast, if heard and naming the
    same serial (or the printer gave none), fills the name and model."""
    if scan is None:
        return {"running": False, "subnet": None, "scanned": 0, "total": 0, "printers": []}
    from backend.app.services.discovery import discovery_service

    heard = {p.ip_address: p for p in discovery_service.discovered_printers}
    printers = []
    for ip, (serial, name, model) in sorted(scan.found.items(), key=lambda item: ipaddress.IPv4Address(item[0])):
        broadcast = heard.get(ip)
        if broadcast is not None:
            b_serial = printer_import._valid_serial(broadcast.serial)
            if serial is None or b_serial == serial:
                serial = serial or b_serial
                name, model = broadcast.name or name, broadcast.model or model
        printers.append({"ip_address": ip, "serial_number": serial, "name": name, "model": model})
    return {
        "running": scan.running,
        "subnet": scan.subnet,
        "scanned": scan.scanned,
        "total": scan.total,
        "printers": printers,
    }


def current() -> Scan | None:
    return _scan
