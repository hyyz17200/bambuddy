"""Print the file a printer printed last from its SD card, instead of uploading it again.

A farm prints the same ``.gcode.3mf`` hundreds of times, and the scheduler
uploads it in full for every job; on an A1 a large file takes minutes. Upstream
cannot keep the file between jobs: after each print it deletes it, because some
firmware starts the last printed file again after a power cycle (#374, #1544).

With this on, the finished file is renamed to :data:`CACHE_NAME` instead of
being deleted. The name has no ``.3mf`` or ``.gcode`` suffix, so the printer
does not see it as something it can print, and there is only ever one per
printer. When the next job sends the same file, it is renamed back and the
upload is skipped. Only the last file counts: a different file is uploaded as
before, and replaces the cached one when it finishes.

"The same file" is decided here, not on the printer: FTPS has no hash command,
and size alone misses a small edit (one digit changed in the plate-swap G-code
usually compresses to the same length). So this process remembers, per printer,
the SHA-256 of the final file it uploaded (after G-code injection) and its size,
and reuses the cached copy only when the file about to be sent hashes the same
and the card still holds a file of that size under :data:`CACHE_NAME`. The
record lives in memory: after a restart each printer gets one ordinary upload.

Two wrappers (:func:`install`), no upstream file changed:

- ``print_scheduler.upload_file_async``, the scheduler's upload (both its direct
  and its ``with_ftp_retry`` call): reuse or upload, and remember what went up.
  The delete the scheduler runs before uploading names the print's own file,
  not :data:`CACHE_NAME`, so it leaves the cached copy alone.
- ``main._cleanup_sd_card_after_print``: rename the file this process uploaded
  to :data:`CACHE_NAME`; anything else, or a rename that fails, goes on to
  upstream's delete.

The other deletes upstream does (the start command failing, a cancel winning
the race) remove the file under its own name; the next job then finds nothing
cached and uploads.
"""

import asyncio
import ftplib
import hashlib
import logging
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from pydantic import BaseModel
from sqlalchemy import select

from backend.app.core import database
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.services.bambu_ftp import BambuFTPClient
from backend.app.services.printer_manager import printer_manager
from backend.app.utils.filename import derive_remote_filename

logger = logging.getLogger(__name__)

SECTION = "sd_reuse"
CACHE_NAME = "/hyyz17200-last.bbcache"
# Each is one FTPS connection doing a listing, a delete and a rename.
RESTORE_TIMEOUT_SECONDS = 60.0
# Inside upstream's 45 s cleanup budget, leaving it time for its own delete.
STASH_TIMEOUT_SECONDS = 25.0
_HASH_CHUNK = 1024 * 1024


class SdReuseSettings(BaseModel):
    """The Enhanced Settings' SD card reuse section."""

    enabled: bool = False


@dataclass
class _Sent:
    """The file this process last put on a printer's card."""

    remote_path: str
    sha256: str
    size: int
    # True once it sits on the card as CACHE_NAME, False while under its own name.
    cached: bool = False


_settings = SdReuseSettings()
# Printer IP -> what is on its card. Keyed by IP because that is all the upload
# is given; the card belongs to whatever answers there.
_sent: dict[str, _Sent] = {}


def apply_settings(value: BaseModel) -> None:
    global _settings
    _settings = SdReuseSettings.model_validate(value.model_dump())


def is_enabled() -> bool:
    return _settings.enabled


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _name(remote_path: str) -> str:
    return PurePosixPath(remote_path).name


def _listed_size(client: BambuFTPClient, remote_path: str) -> int | None:
    """Size of a file in the card's root, from a listing; None when absent.

    A listing rather than SIZE, as upstream's ``find_remote_file_async`` does:
    LIST is what every Bambu firmware answers. FAT ignores case.
    """
    wanted = _name(remote_path).lower()
    for entry in client.list_files("/"):
        if not entry.get("is_directory") and str(entry.get("name", "")).lower() == wanted:
            return entry.get("size")
    return None


def _rename_sync(
    ip: str,
    access_code: str,
    printer_model: str | None,
    socket_timeout: float | None,
    source: str,
    target: str,
    size: int,
    *,
    for_dispatch: bool,
) -> str:
    """Rename ``source`` to ``target`` if ``source`` is there with ``size`` bytes.

    Returns "renamed", or why not: "no_connection", "missing", "size_mismatch",
    "rename_failed". Whatever was at ``target`` is deleted first, because a
    rename onto an existing file is not something to count on.
    """
    client = BambuFTPClient(
        ip,
        access_code,
        timeout=socket_timeout,
        printer_model=printer_model,
        # A dispatch is bounded and someone waits on it, as upstream's upload
        # is (#2898); the after-print rename is background like its delete.
        respect_handshake_cooloff=not for_dispatch,
    )
    if not client.connect():
        return "no_connection"
    try:
        found = _listed_size(client, source)
        if found is None:
            return "missing"
        if found != size:
            return "size_mismatch"
        client.delete_file(target)
        try:
            client._ftp.rename(source, target)
        except (OSError, ftplib.Error) as e:
            logger.warning("hyyz17200 sd reuse: %s: renaming %s to %s failed: %s", ip, source, target, e)
            return "rename_failed"
        return "renamed"
    finally:
        client.disconnect()


async def _rename(
    ip: str, access_code: str, model: str | None, socket_timeout, source, target, size, *, for_dispatch, timeout
) -> str:
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                _rename_sync, ip, access_code, model, socket_timeout, source, target, size, for_dispatch=for_dispatch
            ),
            timeout=timeout,
        )
    except TimeoutError:
        return "timeout"


async def _try_reuse(
    ip: str, access_code: str, local_path: Path, remote_path: str, kwargs: dict
) -> tuple[bool, str, int]:
    """Whether the cached copy was put back as ``remote_path``; with the file's hash and size."""
    size = local_path.stat().st_size
    digest = await asyncio.to_thread(file_sha256, local_path)
    sent = _sent.get(ip)
    if sent is None or not sent.cached:
        return False, digest, size
    if sent.remote_path.lower() != remote_path.lower() or sent.sha256 != digest or sent.size != size:
        logger.info("hyyz17200 sd reuse: %s: %s is not the file printed last, uploading", ip, _name(remote_path))
        return False, digest, size
    outcome = await _rename(
        ip,
        access_code,
        kwargs.get("printer_model"),
        kwargs.get("socket_timeout"),
        CACHE_NAME,
        remote_path,
        size,
        for_dispatch=True,
        timeout=RESTORE_TIMEOUT_SECONDS,
    )
    if outcome != "renamed":
        logger.info("hyyz17200 sd reuse: %s: cached %s not usable (%s), uploading", ip, _name(remote_path), outcome)
        return False, digest, size
    sent.cached = False
    logger.info(
        "hyyz17200 sd reuse: %s: printing %s from the SD card, skipped uploading %.1f MB",
        ip,
        _name(remote_path),
        size / 1_000_000,
    )
    return True, digest, size


def _wrap_upload(original):
    async def upload_file_async(ip_address, access_code, local_path, remote_path, *args, **kwargs):
        if not _settings.enabled:
            return await original(ip_address, access_code, local_path, remote_path, *args, **kwargs)
        digest = None
        size = 0
        try:
            reused, digest, size = await _try_reuse(ip_address, access_code, Path(local_path), remote_path, kwargs)
            if reused:
                progress = kwargs.get("progress_callback")
                if progress is not None:
                    progress(size, size)
                return True
        except Exception:
            logger.exception("hyyz17200 sd reuse: %s: reuse check failed, uploading", ip_address)
        # Whatever the card held is being replaced; until this upload lands
        # there is nothing to reuse.
        _sent.pop(ip_address, None)
        result = await original(ip_address, access_code, local_path, remote_path, *args, **kwargs)
        if result and digest is not None:
            _sent[ip_address] = _Sent(remote_path, digest, size)
        return result

    upload_file_async.hyyz17200 = True
    upload_file_async.__wrapped__ = original
    return upload_file_async


def _is_this_print(remote_name: str, subtask_name: str | None, archive_filename: str | None) -> bool:
    """Whether the finished print is the file at ``remote_name``: by the archive,
    the way upstream's cleanup picks its first candidate, else by the job name."""
    if archive_filename:
        return derive_remote_filename(archive_filename).lower() == remote_name.lower()
    if not subtask_name:
        return False
    from backend.app.main import _subtask_name_from_filename, _subtask_names_match

    return _subtask_names_match(_subtask_name_from_filename(remote_name), subtask_name)


async def stash_after_print(printer_id: int, subtask_name: str | None, archive_id: int | None) -> bool:
    """Rename the finished print's file to CACHE_NAME. False leaves it to upstream's delete."""
    async with database.async_session() as db:
        printer = await db.get(Printer, printer_id)
        if printer is None:
            return False
        ip, access_code, model, name = printer.ip_address, printer.access_code, printer.model, printer.name
        archive_filename = None
        if archive_id:
            archive_filename = await db.scalar(select(PrintArchive.filename).where(PrintArchive.id == archive_id))

    sent = _sent.get(ip)
    if sent is None or sent.cached:
        return False
    remote_name = _name(sent.remote_path)
    if not _is_this_print(remote_name, subtask_name, archive_filename):
        return False
    from backend.app.main import _sd_files_in_use

    if remote_name.lower() in _sd_files_in_use(printer_manager.get_status(printer_id)):
        # Started again from the printer's screen; upstream keeps it as well.
        return False

    outcome = await _rename(
        ip,
        access_code,
        model,
        None,
        sent.remote_path,
        CACHE_NAME,
        sent.size,
        for_dispatch=False,
        timeout=STASH_TIMEOUT_SECONDS,
    )
    if outcome != "renamed":
        _sent.pop(ip, None)
        logger.info("hyyz17200 sd reuse: printer %s: could not keep %s (%s), deleting it", name, remote_name, outcome)
        return False
    sent.cached = True
    logger.info("hyyz17200 sd reuse: printer %s: kept %s on the SD card as %s", name, remote_name, CACHE_NAME)
    return True


def _wrap_cleanup(original):
    async def cleanup_sd_card_after_print(printer_id, subtask_name, archive_id, *args, **kwargs):
        if _settings.enabled:
            try:
                if await stash_after_print(printer_id, subtask_name, archive_id):
                    return None
            except Exception:
                logger.exception("hyyz17200 sd reuse: printer %s: could not keep the file", printer_id)
        return await original(printer_id, subtask_name, archive_id, *args, **kwargs)

    cleanup_sd_card_after_print.hyyz17200 = True
    cleanup_sd_card_after_print.__wrapped__ = original
    return cleanup_sd_card_after_print


def install() -> None:
    """Wrap the scheduler's upload and the after-print cleanup. Idempotent.

    Called from ``register()``, which main.py runs at the end of its module
    body, so main is in ``sys.modules`` with the cleanup already defined.
    """
    from backend.app.services import print_scheduler

    if getattr(print_scheduler.upload_file_async, "hyyz17200", False) is not True:
        print_scheduler.upload_file_async = _wrap_upload(print_scheduler.upload_file_async)

    main = sys.modules.get("backend.app.main")
    if main is None:
        import backend.app.main as main
    if getattr(main._cleanup_sd_card_after_print, "hyyz17200", False) is not True:
        main._cleanup_sd_card_after_print = _wrap_cleanup(main._cleanup_sd_card_after_print)
