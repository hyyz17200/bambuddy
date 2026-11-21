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

Wrappers (:func:`install`), no upstream file changed:

- ``print_scheduler.upload_file_async``, the scheduler's upload (both its direct
  and its ``with_ftp_retry`` call): reuse or upload, and remember what went up.
- ``print_scheduler.delete_file_async``: the scheduler's deletes (the one before
  uploading, and those after a failed start or a lost cancel race), gated as
  below. They name the print's own file, not :data:`CACHE_NAME`, so they leave
  the cached copy alone.
- ``main._cleanup_sd_card_after_print``: rename the file this process uploaded
  to :data:`CACHE_NAME`; anything else, or a rename that fails, goes on to
  upstream's delete.
- ``bambu_ftp.delete_file_async``: gated only inside that cleanup.

The other deletes upstream does (the start command failing, a cancel winning
the race) remove the file under its own name; the next job then finds nothing
cached and uploads.

One write at a time per printer, for as long as its thread runs. A deadline
or a cancel only ends the coroutine's wait: the FTPS thread behind it carries
on, and a late RNTO or DELE could then land on the file the next job has just
written under the same name. So while this is on, every write here (the
scheduler's delete before uploading, the rename back, the upload, the
after-print rename and upstream's delete in the cleanup) waits for the
printer's previous one to *finish its thread*, and a write that runs out of
time is told to send no further command. Other printers are not held up.
A command already sent cannot be taken back; see :func:`_rename_sync` for what
is done when RNTO went out and no answer came back.
"""

import asyncio
import contextvars
import ftplib
import hashlib
import logging
import sys
import threading
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TypeVar

from pydantic import BaseModel
from sqlalchemy import select

from backend.app.core import database
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.services import bambu_ftp
from backend.app.services.bambu_ftp import BambuFTPClient, DeleteResult
from backend.app.services.printer_manager import printer_manager
from backend.app.utils.filename import derive_remote_filename

logger = logging.getLogger(__name__)

SECTION = "sd_reuse"
CACHE_NAME = "/hyyz17200-last.bbcache"
# Each is one FTPS connection doing a listing, a delete and a rename.
RESTORE_TIMEOUT_SECONDS = 60.0
# Inside upstream's 45 s cleanup budget, leaving it time for its own delete.
STASH_TIMEOUT_SECONDS = 25.0
# Socket timeout for the commands of a rename or delete, once connected (each
# wait on the printer, not the whole operation). The caller's, when shorter.
# The connection itself keeps the caller's timeout: an A1's TLS handshake can
# take seconds, and nothing is written before it is done.
WRITE_SOCKET_TIMEOUT = 5.0
_HASH_CHUNK = 1024 * 1024
T = TypeVar("T")


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

# Printer IP -> its write gate. Per event loop: an asyncio.Lock binds to the
# loop that first waits on it, and the tests run each case on a fresh loop.
_gates: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]] = weakref.WeakKeyDictionary()
# Set while the wrapped after-print cleanup runs, so upstream's delete in it
# (``bambu_ftp.delete_file_async``) goes through the gate and nothing else does.
_in_cleanup: contextvars.ContextVar[bool] = contextvars.ContextVar("hyyz17200_sd_reuse_cleanup", default=False)


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


def _consume(fut: asyncio.Future) -> None:
    """Retrieve a result nobody waits for any more, so asyncio does not log it."""
    if not fut.cancelled():
        fut.exception()


def _gate(ip: str) -> asyncio.Lock:
    per_loop = _gates.setdefault(asyncio.get_running_loop(), {})
    lock = per_loop.get(ip)
    if lock is None:
        lock = per_loop[ip] = asyncio.Lock()
    return lock


async def _enter(ip: str, what: str) -> asyncio.Lock:
    """Take the printer's gate. Whoever takes it ties its release to the end of the work."""
    lock = _gate(ip)
    if lock.locked():
        logger.info("hyyz17200 sd reuse: %s: %s waits for the file operation before it", ip, what)
    await lock.acquire()
    return lock


async def _run_in_thread(ip: str, what: str, work: Callable[[threading.Event], T], *, deadline: float) -> T:
    """Run ``work(stop)`` in an FTP thread, holding the printer's gate until the thread ends.

    At ``deadline`` the thread is told to stop before its next command and its
    own answer is waited for, bounded by its socket timeouts: what it last did
    decides what is on the card. Cancelled, the caller leaves at once; the gate
    stays shut until the thread has gone.
    """
    loop = asyncio.get_running_loop()
    lock = await _enter(ip, what)
    stop = threading.Event()
    try:
        fut = loop.run_in_executor(bambu_ftp._ftp_executor, work, stop)
    except BaseException:
        lock.release()
        raise
    fut.add_done_callback(lambda _f: lock.release())
    try:
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=deadline)
        except TimeoutError:
            stop.set()
            logger.warning(
                "hyyz17200 sd reuse: %s: %s took over %.0fs; it sends no further command, waiting for it to end",
                ip,
                what,
                deadline,
            )
            return await asyncio.shield(fut)
    except BaseException:
        stop.set()
        fut.add_done_callback(_consume)
        raise


def _connect(
    ip: str, access_code: str, printer_model: str | None, socket_timeout: float | None, *, respect_cooloff: bool
) -> BambuFTPClient | None:
    client = BambuFTPClient(
        ip,
        access_code,
        timeout=socket_timeout,
        printer_model=printer_model,
        respect_handshake_cooloff=respect_cooloff,
    )
    if not client.connect():
        return None
    short = min(client.timeout, WRITE_SOCKET_TIMEOUT)
    client._ftp.timeout = short  # data connections (the listing)
    if client._ftp.sock is not None:
        client._ftp.sock.settimeout(short)
    return client


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
    stop: threading.Event | None = None,
) -> str:
    """Rename ``source`` to ``target`` if ``source`` is there with ``size`` bytes.

    Returns "renamed", or why not: "no_connection", "missing", "size_mismatch",
    "rename_failed", "cancelled" (``stop`` was set before a command that
    writes), or "unconfirmed": RNTO went out and no answer came back, so the
    file may be under either name. Whatever was at ``target`` is deleted
    first, because a rename onto an existing file is not something to count on.

    RNFR and RNTO are sent one by one, so ``stop`` is honoured between them.
    """
    stop = stop or threading.Event()
    client = _connect(ip, access_code, printer_model, socket_timeout, respect_cooloff=not for_dispatch)
    if client is None:
        return "no_connection"
    try:
        if stop.is_set():
            return "cancelled"
        found = _listed_size(client, source)
        if found is None:
            return "missing"
        if found != size:
            return "size_mismatch"
        ftp = client._ftp
        try:
            if stop.is_set():
                return "cancelled"
            client.delete_file(target)
            if stop.is_set():
                return "cancelled"
            reply = ftp.sendcmd(f"RNFR {source}")
            if not reply.startswith("3"):
                raise ftplib.error_reply(reply)
            if stop.is_set():
                return "cancelled"
        except (OSError, EOFError, ftplib.Error) as e:
            logger.warning("hyyz17200 sd reuse: %s: renaming %s to %s failed: %s", ip, source, target, e)
            return "rename_failed"
        try:
            ftp.voidcmd(f"RNTO {target}")
        except (ftplib.error_perm, ftplib.error_temp) as e:
            logger.warning("hyyz17200 sd reuse: %s: renaming %s to %s failed: %s", ip, source, target, e)
            return "rename_failed"
        except (OSError, EOFError, ftplib.Error) as e:
            logger.warning("hyyz17200 sd reuse: %s: renaming %s to %s not confirmed: %s", ip, source, target, e)
            return "unconfirmed"
        return "renamed"
    finally:
        client.disconnect()


def _delete_sync(
    ip: str,
    access_code: str,
    printer_model: str | None,
    socket_timeout: float | None,
    remote_path: str,
    *,
    respect_cooloff: bool,
    stop: threading.Event,
) -> DeleteResult:
    client = _connect(ip, access_code, printer_model, socket_timeout, respect_cooloff=respect_cooloff)
    if client is None:
        return DeleteResult.FAILED
    try:
        if stop.is_set():
            return DeleteResult.FAILED
        try:
            return client.delete_file(remote_path)
        except EOFError as e:
            logger.warning("hyyz17200 sd reuse: %s: deleting %s failed: %s", ip, remote_path, e)
            return DeleteResult.FAILED
    finally:
        client.disconnect()


async def _rename(
    ip: str, access_code: str, model: str | None, socket_timeout, source, target, size, *, for_dispatch, timeout
) -> str:
    return await _run_in_thread(
        ip,
        f"renaming {source} to {target}",
        lambda stop: _rename_sync(
            ip, access_code, model, socket_timeout, source, target, size, for_dispatch=for_dispatch, stop=stop
        ),
        deadline=timeout,
    )


async def _gated_delete(
    ip_address: str,
    access_code: str,
    remote_path: str,
    socket_timeout: float | None = None,
    printer_model: str | None = None,
    timeout: float = 60.0,
    respect_handshake_cooloff: bool = True,
) -> DeleteResult:
    """``bambu_ftp.delete_file_async``, through the printer's gate."""
    return await _run_in_thread(
        ip_address,
        f"deleting {remote_path}",
        lambda stop: _delete_sync(
            ip_address,
            access_code,
            printer_model,
            socket_timeout,
            remote_path,
            respect_cooloff=respect_handshake_cooloff,
            stop=stop,
        ),
        deadline=timeout,
    )


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
    if outcome == "unconfirmed":
        # The card may hold the file under its own name now, and a printer that
        # will not STOR over an existing file answers the upload with 553. A
        # fresh connection clears the name first.
        _sent.pop(ip, None)
        cleared = await _gated_delete(
            ip,
            access_code,
            remote_path,
            kwargs.get("socket_timeout"),
            kwargs.get("printer_model"),
            timeout=RESTORE_TIMEOUT_SECONDS,
            respect_handshake_cooloff=False,
        )
        logger.info(
            "hyyz17200 sd reuse: %s: putting back %s not confirmed; cleared the name (%s), uploading",
            ip,
            _name(remote_path),
            cleared.value,
        )
        return False, digest, size
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


def _stoppable_progress(args: tuple, kwargs: dict, stop: threading.Event, remote_path: str) -> tuple[tuple, dict]:
    """The upload's progress callback, made to stop the transfer once ``stop`` is set.

    Upstream's upload calls it after every chunk and, when it raises, stops
    sending and removes the partial file.
    """
    args = list(args)
    positional = len(args) >= 2  # (timeout, progress_callback, ...)
    callback = args[1] if positional else kwargs.get("progress_callback")

    def progress(uploaded: int, total: int) -> None:
        if stop.is_set():
            raise bambu_ftp.UploadCancelled(f"upload of {remote_path} was cancelled")
        if callback is not None:
            callback(uploaded, total)

    if positional:
        args[1] = progress
    else:
        kwargs = {**kwargs, "progress_callback": progress}
    return tuple(args), kwargs


async def _upload_in_gate(original, ip_address, access_code, local_path, remote_path, args, kwargs):
    """Upstream's upload, holding the printer's gate until upstream's call ends.

    Upstream bounds its own transfer (deadline, then a grace for the thread to
    stop). A cancel here does not cut that short: it stops the transfer at its
    next chunk, and the gate opens when upstream's call is over.
    """
    loop = asyncio.get_running_loop()
    lock = await _enter(ip_address, f"uploading {remote_path}")
    stop = threading.Event()
    args, kwargs = _stoppable_progress(args, kwargs, stop, remote_path)
    try:
        task = loop.create_task(original(ip_address, access_code, local_path, remote_path, *args, **kwargs))
    except BaseException:
        lock.release()
        raise
    task.add_done_callback(lambda _t: lock.release())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        stop.set()
        task.add_done_callback(_consume)
        raise


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
        result = await _upload_in_gate(original, ip_address, access_code, local_path, remote_path, args, kwargs)
        if result and digest is not None:
            _sent[ip_address] = _Sent(remote_path, digest, size)
        return result

    upload_file_async.hyyz17200 = True
    upload_file_async.__wrapped__ = original
    return upload_file_async


def _wrap_delete(original, *, only_in_cleanup: bool):
    """Route a delete through the printer's gate while this is on.

    ``only_in_cleanup``: for ``bambu_ftp.delete_file_async``, which the whole
    app uses; only the call inside the wrapped after-print cleanup is gated.
    """

    async def delete_file_async(ip_address, access_code, remote_path, *args, **kwargs):
        if not _settings.enabled or (only_in_cleanup and not _in_cleanup.get()):
            return await original(ip_address, access_code, remote_path, *args, **kwargs)
        return await _gated_delete(ip_address, access_code, remote_path, *args, **kwargs)

    delete_file_async.hyyz17200 = True
    delete_file_async.__wrapped__ = original
    return delete_file_async


def _is_this_print(remote_name: str, subtask_name: str | None, archive_filename: str | None) -> bool:
    """Whether the finished print is the file at ``remote_name``: by the archive,
    the way upstream's cleanup picks its first candidate, else by the job name."""
    if archive_filename:
        return derive_remote_filename(archive_filename).lower() == remote_name.lower()
    if not subtask_name:
        return False
    from backend.app.main import _subtask_name_from_filename, _subtask_names_match

    return _subtask_names_match(_subtask_name_from_filename(remote_name), subtask_name)


async def _lookup(printer_id: int, archive_id: int | None) -> tuple[str, str, str | None, str, str | None] | None:
    """The printer's IP, access code, model and name, and the archive's file name."""
    async with database.async_session() as db:
        printer = await db.get(Printer, printer_id)
        if printer is None:
            return None
        archive_filename = None
        if archive_id:
            archive_filename = await db.scalar(select(PrintArchive.filename).where(PrintArchive.id == archive_id))
        return printer.ip_address, printer.access_code, printer.model, printer.name, archive_filename


async def stash_after_print(printer_id: int, subtask_name: str | None, archive_id: int | None) -> bool:
    """Rename the finished print's file to CACHE_NAME. False leaves it to upstream's delete."""
    found = await _lookup(printer_id, archive_id)
    if found is None:
        return False
    ip, access_code, model, name, archive_filename = found

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

    try:
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
    except asyncio.CancelledError:
        # Upstream's cleanup budget ran out. Which name the file ended up
        # under is not known, so nothing on the card is reused.
        _sent.pop(ip, None)
        raise
    if outcome != "renamed":
        # "unconfirmed" as well: the file may be the cache now, but that is not
        # known. Upstream deletes it under its own name if it is still there.
        _sent.pop(ip, None)
        logger.info("hyyz17200 sd reuse: printer %s: could not keep %s (%s), deleting it", name, remote_name, outcome)
        return False
    sent.cached = True
    logger.info("hyyz17200 sd reuse: printer %s: kept %s on the SD card as %s", name, remote_name, CACHE_NAME)
    return True


def _wrap_cleanup(original):
    async def cleanup_sd_card_after_print(printer_id, subtask_name, archive_id, *args, **kwargs):
        if not _settings.enabled:
            return await original(printer_id, subtask_name, archive_id, *args, **kwargs)
        token = _in_cleanup.set(True)
        try:
            try:
                if await stash_after_print(printer_id, subtask_name, archive_id):
                    return None
            except Exception:
                logger.exception("hyyz17200 sd reuse: printer %s: could not keep the file", printer_id)
            return await original(printer_id, subtask_name, archive_id, *args, **kwargs)
        finally:
            _in_cleanup.reset(token)

    cleanup_sd_card_after_print.hyyz17200 = True
    cleanup_sd_card_after_print.__wrapped__ = original
    return cleanup_sd_card_after_print


def install() -> None:
    """Wrap the scheduler's upload and deletes, upstream's delete and the after-print cleanup. Idempotent.

    Called from ``register()``, which main.py runs at the end of its module
    body, so main is in ``sys.modules`` with the cleanup already defined.
    print_scheduler bound ``delete_file_async`` when it was imported, so its
    name is wrapped on its own; main imports it from ``bambu_ftp`` inside the
    cleanup, where the wrapper gates it.
    """
    from backend.app.services import print_scheduler

    if getattr(print_scheduler.upload_file_async, "hyyz17200", False) is not True:
        print_scheduler.upload_file_async = _wrap_upload(print_scheduler.upload_file_async)
    if getattr(print_scheduler.delete_file_async, "hyyz17200", False) is not True:
        print_scheduler.delete_file_async = _wrap_delete(print_scheduler.delete_file_async, only_in_cleanup=False)
    if getattr(bambu_ftp.delete_file_async, "hyyz17200", False) is not True:
        bambu_ftp.delete_file_async = _wrap_delete(bambu_ftp.delete_file_async, only_in_cleanup=True)

    main = sys.modules.get("backend.app.main")
    if main is None:
        import backend.app.main as main
    if getattr(main._cleanup_sd_card_after_print, "hyyz17200", False) is not True:
        main._cleanup_sd_card_after_print = _wrap_cleanup(main._cleanup_sd_card_after_print)
