"""What a printer reports about its own calibration, read from its raw MQTT reports.

Bed levelling and vibration compensation run on every Bambu printer. Motor
noise cancellation does not, and the printer says whether it has it: bit 21 of
``print.home_flag``, or bit 10 of ``fun`` on printers with the newer protocol.
Bambu Studio offers the option from exactly those bits, and so does the batch.

Upstream's status parsing keeps neither field, so this registers a raw-message
handler (the hook the virtual printer's MQTT bridge uses) on the printers it is
asked about. The support bit is latched: a report with it set is believed, a
report without it is not, because heartbeat reports leave some home_flag bits
clear on printers that have the feature (see bambu_mqtt's SD-card note). Never
having seen the bit set means "not supported", which only leaves motor noise
out of that printer's calibration.

``mc_print_stage`` is kept too, only for the batch's log: Bambu Studio reads
the calibration as done when it changes to 1.
"""

import asyncio
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from backend.app.services.printer_manager import printer_manager

logger = logging.getLogger(__name__)

MOTOR_NOISE_HOME_FLAG_BIT = 21
MOTOR_NOISE_FUN_BIT = 10

# How long a probe waits for a full report after asking for one.
PROBE_SECONDS = 4.0


@dataclass
class _Watch:
    client: object
    handler: Callable[[str, bytes], None] | None = None
    # A home_flag or fun has arrived since the handler was registered.
    reported: bool = False
    motor_noise: bool = False
    mc_print_stage: object = None
    home_flag: int | None = None


_watches: dict[int, _Watch] = {}


def _flag_bit(value: object, bit: int) -> bool | None:
    """One bit of a flags field: home_flag is an int (negative when bit 31 is
    set), fun a hex string. ``None`` when it is neither."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = int(value, 16)
        except ValueError:
            return None
    if not isinstance(value, int):
        return None
    return bool(((value & 0xFFFFFFFFFFFFFFFF) >> bit) & 1)


def _on_report(watch: _Watch, topic: str, payload: bytes) -> None:
    """Runs on paho's network thread: cheap, and never raises."""
    if not topic.endswith("/report"):
        return
    if b'"home_flag"' not in payload and b'"fun"' not in payload and b'"mc_print_stage"' not in payload:
        return
    try:
        data = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return
    if not isinstance(data, dict):
        return
    report = data.get("print")
    report = report if isinstance(report, dict) else {}

    home_flag = report.get("home_flag")
    home_bit = _flag_bit(home_flag, MOTOR_NOISE_HOME_FLAG_BIT)
    # fun comes at the top level on some firmware and inside print on others.
    fun_bit = _flag_bit(report.get("fun", data.get("fun")), MOTOR_NOISE_FUN_BIT)
    if home_bit is not None or fun_bit is not None:
        watch.reported = True
        if isinstance(home_flag, int) and not isinstance(home_flag, bool):
            watch.home_flag = home_flag & 0xFFFFFFFF
        if home_bit or fun_bit:
            watch.motor_noise = True
    if "mc_print_stage" in report:
        watch.mc_print_stage = report["mc_print_stage"]


def watch(printer_id: int) -> bool:
    """Start reading the printer's reports. Safe to repeat; follows a reconnect
    that replaced the client. False when the printer has no client."""
    client = printer_manager.get_client(printer_id)
    if client is None:
        return False
    current = _watches.get(printer_id)
    if current is not None and current.client is client:
        return True
    if current is not None:
        forget(printer_id)
    entry = _Watch(client=client)
    entry.handler = lambda topic, payload: _on_report(entry, topic, payload)
    try:
        client.register_raw_message_handler(entry.handler)
    except Exception:
        logger.warning("hyyz17200: could not watch printer %s reports", printer_id, exc_info=True)
        return False
    _watches[printer_id] = entry
    return True


def forget(printer_id: int) -> None:
    entry = _watches.pop(printer_id, None)
    if entry is None or entry.handler is None:
        return
    try:
        entry.client.unregister_raw_message_handler(entry.handler)
    except Exception:
        logger.debug("hyyz17200: could not unregister printer %s watch", printer_id, exc_info=True)


def _current(printer_id: int) -> _Watch | None:
    entry = _watches.get(printer_id)
    if entry is None or entry.client is not printer_manager.get_client(printer_id):
        return None
    return entry


def motor_noise_supported(printer_id: int) -> bool | None:
    """True or False once the printer has reported its flags; None before that."""
    entry = _current(printer_id)
    if entry is None or not entry.reported:
        return None
    return entry.motor_noise


def mc_print_stage(printer_id: int) -> object:
    entry = _current(printer_id)
    return entry.mc_print_stage if entry is not None else None


def home_flag(printer_id: int) -> int | None:
    entry = _current(printer_id)
    return entry.home_flag if entry is not None else None


async def probe(printer_ids: Iterable[int], wait: float = PROBE_SECONDS) -> dict[int, bool | None]:
    """Whether each printer reports motor noise cancellation.

    Asks every connected printer not yet seen with the bit set for a full
    report, and waits up to ``wait`` seconds for the bit to show. A heartbeat
    without it does not end the wait early, since it may simply not carry it.
    ``None`` is a printer that reported no flags at all.
    """
    ids = list(dict.fromkeys(printer_ids))
    asked = []
    for printer_id in ids:
        if not printer_manager.is_connected(printer_id) or not watch(printer_id):
            continue
        if motor_noise_supported(printer_id) is not True:
            try:
                printer_manager.request_status_update(printer_id)
                asked.append(printer_id)
            except Exception:
                logger.debug("hyyz17200: pushall to printer %s failed", printer_id, exc_info=True)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    while asked and loop.time() < deadline:
        if all(motor_noise_supported(pid) is True for pid in asked):
            break
        await asyncio.sleep(0.2)
    return {pid: motor_noise_supported(pid) for pid in ids}
