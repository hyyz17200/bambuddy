"""Fault codes the user chose to stop being alerted about (upstream issue #3269).

A BMCU makes the printer report "AMS firmware does not match" forever, which
keeps every HMS indicator stuck on. Hiding happens only where a fault is
announced: push notifications, the MQTT relay's alert and Live Activities here,
and the badges in the frontend's hiddenFaults.ts. PrinterState.hms_errors, the
API, the scheduler and failure reasons all keep seeing every fault.

Status updates are synchronous and frequent, so the codes are read from a cache
rather than the database. run_migrations() fills it, which covers startup and
backup restores; the API routes refresh it after each change.
"""

import re
from collections.abc import Iterable
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from backend.app.hyyz17200.models.hidden_fault import HiddenFault

T = TypeVar("T")

_hidden_codes: frozenset[str] = frozenset()


def normalize_code(raw: str) -> str:
    """``0500_0400-0001 0044`` as ``0500040000010044``. Raises ValueError if invalid."""
    code = re.sub(r"[\s_-]", "", raw).upper().removeprefix("0X")
    if not re.fullmatch(r"[0-9A-F]{8}|[0-9A-F]{16}", code):
        raise ValueError("A fault code has 8 or 16 hexadecimal digits")
    return code


def is_hidden_code(full_code: str | None) -> bool:
    """Whether a fault's ``full_code`` is hidden. Keep in step with hiddenFaults.ts.

    An 8-digit entry also covers the ``hms[]`` form of that fault. The parser drops
    a ``print_error`` already present in ``hms[]``, so 0500_4004 can arrive only as
    0500xxxxxxxx4004. A 16-digit entry is exact: it never widens to a short code.
    """
    code = (full_code or "").upper()
    return code in _hidden_codes or (len(code) == 16 and code[:4] + code[12:] in _hidden_codes)


def visible_faults(errors: Iterable[T] | None) -> list[T]:
    """The faults to announce. Returns a new list and leaves ``errors`` untouched."""
    return [e for e in errors or [] if not is_hidden_code(getattr(e, "full_code", ""))]


def set_hidden_codes(codes: Iterable[str]) -> None:
    global _hidden_codes
    _hidden_codes = frozenset(codes)


async def load_hidden_codes(db: AsyncConnection | AsyncSession) -> None:
    result = await db.execute(select(HiddenFault.code))
    set_hidden_codes(result.scalars().all())
