"""sd_reuse's file writes against mock FTPS printers whose answers come late or never.

A deadline or a cancel ends the coroutine's wait, not the FTPS thread behind
it. These cases hold a command's answer back (or drop the connection after
carrying it out) and check that the printer's next write waits for that thread,
that the thread sends nothing more once told to stop, and that another printer
is not held up. Everything goes through the real entry points: the scheduler's
``upload_file_async`` and ``delete_file_async`` (as wrapped by ``install()``)
and the wrapped after-print cleanup.

Two servers: printer A on 127.0.0.1, printer B on 127.0.0.2, same port, so
``BambuFTPClient.FTP_PORT`` reaches both. The handler hooks live here, not in
mock_ftp_server.py, which stays as upstream has it.
"""

import asyncio
import logging
import os
import socket
import ssl
import threading
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.servers import FTPServer

from backend.app.hyyz17200 import sd_reuse
from backend.app.services import bambu_ftp, print_scheduler
from backend.app.services.bambu_ftp import BambuFTPClient
from backend.tests.unit.services.mock_ftp_server import MockBambuFTPServer

# Not A1: an A1's prot_p handshake fails against the mock server, which arms
# the client's handshake cool-off. The FTPS client is the same for every model.
MODEL = "X1C"
IP_A = "127.0.0.1"
IP_B = "127.0.0.2"
CODE = "12345678"
JOB = "/job.3mf"
CACHE_FILE = sd_reuse.CACHE_NAME.lstrip("/")


class Control:
    """What one mock printer was sent, and which answers it holds back."""

    def __init__(self):
        self.log: list[tuple[int, str, str]] = []  # (session, command, argument)
        self.holds: dict[str, tuple[threading.Event, threading.Event]] = {}
        self.drop_after_rnto = False
        self.refuse_overwrite = False
        self.refused = 0

    def hold(self, command: str) -> tuple[threading.Event, threading.Event]:
        """Hold the next ``command``: not carried out or answered until released."""
        events = (threading.Event(), threading.Event())
        self.holds[command] = events
        return events

    def commands(self) -> list[str]:
        return [cmd for _, cmd, _ in self.log]

    def sessions_of(self, command: str) -> list[int]:
        return [session for session, cmd, _ in self.log if cmd == command]


def _hooked(base: type, ctl: Control) -> type:
    class Handler(base):
        def pre_process_command(self, line, cmd, arg):
            ctl.log.append((id(self), cmd.upper(), arg or ""))
            return super().pre_process_command(line, cmd, arg)

        def _held(self, command, run):
            hold = ctl.holds.pop(command, None)
            if hold is None:
                return run()
            seen, release = hold
            seen.set()

            def poll():
                if getattr(self, "_closed", False):
                    return
                if release.is_set():
                    run()
                else:
                    self.ioloop.call_later(0.02, poll, _errback=self.handle_error)

            poll()

        def ftp_RNFR(self, path):
            return self._held("RNFR", lambda: base.ftp_RNFR(self, path))

        def ftp_DELE(self, path):
            return self._held("DELE", lambda: base.ftp_DELE(self, path))

        def ftp_RNTO(self, path):
            def run():
                if ctl.drop_after_rnto:
                    # Carried out, then the line drops before the answer.
                    ctl.drop_after_rnto = False
                    source, self._rnfr = self._rnfr, None
                    self.run_as_current_user(self.fs.rename, source, path)
                    self.close()
                    return
                base.ftp_RNTO(self, path)

            return self._held("RNTO", run)

        def ftp_STOR(self, file):
            if ctl.refuse_overwrite and os.path.isfile(file):
                ctl.refused += 1
                self.respond("553 Could not create file.")
                return
            return base.ftp_STOR(self, file)

    return Handler


def _free_port() -> int:
    for _ in range(50):
        with socket.socket() as first, socket.socket() as second:
            first.bind((IP_A, 0))
            port = first.getsockname()[1]
            try:
                second.bind((IP_B, port))
            except OSError:
                continue
            return port
    raise RuntimeError("no port free on both loopback addresses")


def _server(host: str, port: int, root: Path, certs, ioloop=None) -> MockBambuFTPServer:
    """A mock printer, configured as ``MockBambuFTPServer.start`` does, not yet serving."""
    root.mkdir()
    server = MockBambuFTPServer(host, port, str(root), certs[0], certs[1], access_code=CODE)
    server.ctl = Control()
    handler = server._handler_class = _hooked(server._handler_class, server.ctl)
    authorizer = DummyAuthorizer()
    authorizer.add_user("bblp", CODE, str(root), perm="elradfmwMT")
    handler.authorizer = authorizer
    handler.certfile, handler.keyfile = certs
    handler.passive_ports = range(60000, 60101)
    handler.tls_control_required = False
    handler.tls_data_required = False
    handler.ssl_context = None
    server._server = FTPServer((host, port), handler, ioloop=ioloop)
    server._server.max_cons = 10
    server._server.max_cons_per_ip = 5
    return server


@pytest.fixture
def printers(ftp_certs, tmp_path):
    """Printers A and B, served by one thread.

    Two pyftpdlib TLS servers in two threads crash the process on Windows
    (0xc0000374, in the handshake); one I/O loop serving both listeners does not.
    """
    logging.getLogger("pyftpdlib").setLevel(logging.CRITICAL)
    port = _free_port()
    a = _server(IP_A, port, tmp_path / "a", ftp_certs)
    b = _server(IP_B, port, tmp_path / "b", ftp_certs, ioloop=a._server.ioloop)
    thread = threading.Thread(target=a._server.serve_forever, kwargs={"timeout": 0.05}, daemon=True)
    thread.start()
    try:
        with patch.object(BambuFTPClient, "FTP_PORT", port):
            yield a, b
    finally:
        # From the server's own thread: closing its TLS sockets from this one,
        # as MockBambuFTPServer.stop does, races the thread using them.
        a._server.ioloop.call_later(0, a._server.close_all)
        thread.join(timeout=10)


@pytest.fixture(autouse=True)
def _upload_closes_tls_first():
    """In this test process only, end an upload's TLS data channel before closing it.

    ``upload_file`` closes the channel without the TLS close handshake; the
    mock server then waits in its TLS shutdown and never answers 226 (see the
    test_bambu_ftp.py notes in the fork's rules). Real printers are not
    changed here: ``bambu_ftp.py`` is not touched.
    """
    original = bambu_ftp.ImplicitFTP_TLS.ntransfercmd

    def ntransfercmd(self, cmd, rest=None):
        conn, size = original(self, cmd, rest)
        if cmd.startswith("STOR") and isinstance(conn, ssl.SSLSocket):
            close = conn.close

            def close_after_unwrap():
                try:
                    conn.unwrap()
                except (OSError, ValueError):
                    pass
                close()

            conn.close = close_after_unwrap
        return conn, size

    with patch.object(bambu_ftp.ImplicitFTP_TLS, "ntransfercmd", ntransfercmd):
        yield


@pytest.fixture(autouse=True)
def _sd_reuse_on():
    sd_reuse.install()
    before = sd_reuse._settings
    sd_reuse._sent.clear()
    sd_reuse.apply_settings(sd_reuse.SdReuseSettings(enabled=True))
    yield
    sd_reuse._sent.clear()
    sd_reuse._settings = before


def _file(tmp_path: Path, name: str, content: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(content)
    return path


def _cached(ip: str, path: Path) -> None:
    """What a finished print leaves behind: our file, kept as the cache."""
    sd_reuse._sent[ip] = sd_reuse._Sent(JOB, sd_reuse.file_sha256(path), path.stat().st_size, cached=True)


async def _upload(ip: str, path: Path, progress=None) -> bool:
    """The scheduler's upload call, as ``_start_print`` makes it."""
    return await print_scheduler.upload_file_async(
        ip,
        CODE,
        path,
        JOB,
        socket_timeout=10.0,
        printer_model=MODEL,
        progress_callback=progress,
        respect_handshake_cooloff=False,
    )


async def _delete(ip: str) -> bambu_ftp.DeleteResult:
    """The scheduler's delete before uploading."""
    return await print_scheduler.delete_file_async(
        ip, CODE, JOB, socket_timeout=10.0, printer_model=MODEL, respect_handshake_cooloff=False
    )


async def _until(predicate, timeout: float = 15.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not predicate():
        assert loop.time() < end, "timed out waiting"
        await asyncio.sleep(0.02)


async def _cancel(task: asyncio.Task) -> None:
    """What upstream's 45 s budget around the cleanup does to it."""
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


class TestRestore:
    """Putting the cached copy back before a job."""

    @pytest.mark.asyncio
    async def test_an_rnfr_answered_after_the_deadline_is_not_followed_by_rnto(self, printers, tmp_path):
        a, _ = printers
        content = b"G1 X10 Y10\n" * 300
        local = _file(tmp_path, "job.3mf", content)
        a.add_file(CACHE_FILE, content)
        _cached(IP_A, local)
        seen, release = a.ctl.hold("RNFR")

        with patch.object(sd_reuse, "RESTORE_TIMEOUT_SECONDS", 0.5):
            job = asyncio.create_task(_upload(IP_A, local))
            await asyncio.to_thread(seen.wait, 15)
            await asyncio.sleep(1.5)  # three times the deadline

            # The old thread still waits on RNFR: no upload beside it.
            assert not job.done()
            assert "STOR" not in a.ctl.commands()

            release.set()
            assert await asyncio.wait_for(job, 30) is True

        commands = a.ctl.commands()
        assert "RNTO" not in commands
        assert commands.index("STOR") > commands.index("RNFR")
        assert a.read_file("job.3mf") == content
        assert sd_reuse._sent[IP_A].cached is False

    @pytest.mark.asyncio
    async def test_an_rnto_carried_out_but_never_answered_is_cleared_before_uploading(self, printers, tmp_path):
        """The printer renamed the cache, the line dropped, and it will not STOR over a file."""
        a, _ = printers
        content = b"G1 X10 Y10\n" * 300
        local = _file(tmp_path, "job.3mf", content)
        a.add_file(CACHE_FILE, content)
        _cached(IP_A, local)
        a.ctl.drop_after_rnto = True
        a.ctl.refuse_overwrite = True

        assert await asyncio.wait_for(_upload(IP_A, local), 30) is True

        assert a.ctl.refused == 0
        log = a.ctl.log
        rnto = next(i for i, (_, cmd, _) in enumerate(log) if cmd == "RNTO")
        after = log[rnto + 1 :]
        dele = next(entry for entry in after if entry[1] == "DELE")
        assert dele[2] == JOB
        assert dele[0] != log[rnto][0]  # a new connection
        assert after.index(dele) < next(i for i, entry in enumerate(after) if entry[1] == "STOR")
        assert a.read_file("job.3mf") == content
        assert not a.file_exists(CACHE_FILE)
        assert sd_reuse._sent[IP_A].cached is False


class TestCleanupCancelled:
    """Upstream's budget cancels the after-print cleanup mid-command."""

    @pytest.mark.asyncio
    async def test_a_late_delete_holds_the_printer_and_not_the_others(self, printers, tmp_path):
        a, b = printers
        a.add_file("job.3mf", b"the finished print")
        seen, release = a.ctl.hold("DELE")

        async def upstream_cleanup(printer_id, subtask_name, archive_id, logger):
            # As main._cleanup_sd_card_after_print does it.
            from backend.app.services.bambu_ftp import delete_file_async

            await delete_file_async(IP_A, CODE, JOB, printer_model=MODEL)

        cleanup = sd_reuse._wrap_cleanup(upstream_cleanup)
        with patch.object(sd_reuse, "stash_after_print", AsyncMock(return_value=False)):
            task = asyncio.create_task(cleanup(1, "job", None, None))
            await asyncio.to_thread(seen.wait, 15)
            await _cancel(task)

        # The next job on A, same file name, uploads.
        new = b"the next job"
        nxt = asyncio.create_task(_upload(IP_A, _file(tmp_path, "next.3mf", new)))

        # B is not held up.
        assert await asyncio.wait_for(_upload(IP_B, _file(tmp_path, "b.3mf", b"other printer")), 30) is True
        assert b.read_file("job.3mf") == b"other printer"

        await asyncio.sleep(0.5)
        assert not nxt.done()
        assert "STOR" not in a.ctl.commands()

        release.set()
        assert await asyncio.wait_for(nxt, 30) is True
        # The old DELE went first; the new file is what is left.
        assert a.read_file("job.3mf") == new

    @pytest.mark.asyncio
    async def test_a_late_rename_to_the_cache_holds_the_next_jobs_delete_and_upload(self, printers, tmp_path):
        a, b = printers
        old = b"the finished print"
        a.add_file("job.3mf", old)
        sd_reuse._sent[IP_A] = sd_reuse._Sent(JOB, "hash", len(old))
        seen, release = a.ctl.hold("RNTO")
        upstream_cleanup = AsyncMock()
        cleanup = sd_reuse._wrap_cleanup(upstream_cleanup)

        with (
            patch.object(sd_reuse, "_lookup", AsyncMock(return_value=(IP_A, CODE, MODEL, "A1-01", None))),
            patch.object(sd_reuse.printer_manager, "get_status", MagicMock(return_value=None)),
        ):
            task = asyncio.create_task(cleanup(1, "job", None, None))
            await asyncio.to_thread(seen.wait, 15)
            await _cancel(task)

        upstream_cleanup.assert_not_awaited()
        # Which name the file ended up under is not known: nothing is reused.
        assert IP_A not in sd_reuse._sent

        new = b"the next job, other content"

        async def next_job():
            await _delete(IP_A)
            return await _upload(IP_A, _file(tmp_path, "next.3mf", new))

        nxt = asyncio.create_task(next_job())
        assert await asyncio.wait_for(_delete(IP_B), 30) == bambu_ftp.DeleteResult.NOT_FOUND
        await asyncio.sleep(0.5)
        assert not nxt.done()
        assert a.ctl.commands().count("DELE") == 1  # only the cleanup's, before its RNFR
        assert "STOR" not in a.ctl.commands()

        release.set()
        assert await asyncio.wait_for(nxt, 30) is True
        assert a.read_file("job.3mf") == new
        assert a.read_file(CACHE_FILE) == old


class TestReuse:
    @pytest.mark.asyncio
    async def test_uploaded_once_reused_then_a_same_size_edit_uploaded(self, printers, tmp_path):
        a, _ = printers
        first = b"G1 Y250\n" * 400
        local = _file(tmp_path, "job.3mf", first)
        lookup = AsyncMock(return_value=(IP_A, CODE, MODEL, "A1-01", None))

        async def printed() -> None:
            with (
                patch.object(sd_reuse, "_lookup", lookup),
                patch.object(sd_reuse.printer_manager, "get_status", MagicMock(return_value=None)),
            ):
                assert await sd_reuse.stash_after_print(1, "job", None) is True

        progress = MagicMock()
        assert await asyncio.wait_for(_upload(IP_A, local, progress), 30) is True
        progress.assert_called_with(len(first), len(first))
        assert a.ctl.commands().count("STOR") == 1
        await printed()
        assert a.read_file(CACHE_FILE) == first

        progress = MagicMock()
        assert await asyncio.wait_for(_upload(IP_A, local, progress), 30) is True
        assert a.ctl.commands().count("STOR") == 1
        progress.assert_called_once_with(len(first), len(first))
        assert a.read_file("job.3mf") == first
        assert not a.file_exists(CACHE_FILE)
        await printed()

        edited = b"G1 Y260\n" * 400
        assert len(edited) == len(first)
        assert await asyncio.wait_for(_upload(IP_A, _file(tmp_path, "edit.3mf", edited)), 30) is True
        assert a.ctl.commands().count("STOR") == 2
        assert a.read_file("job.3mf") == edited

    @pytest.mark.asyncio
    async def test_off_the_deletes_are_upstreams(self, printers):
        sd_reuse.apply_settings(sd_reuse.SdReuseSettings(enabled=False))
        with patch.object(sd_reuse, "_gated_delete", AsyncMock()) as gated:
            assert await _delete(IP_B) == bambu_ftp.DeleteResult.NOT_FOUND
            assert await bambu_ftp.delete_file_async(IP_B, CODE, JOB) == bambu_ftp.DeleteResult.NOT_FOUND
        gated.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_on_only_the_cleanups_upstream_delete_is_gated(self, printers):
        with patch.object(sd_reuse, "_gated_delete", AsyncMock()) as gated:
            assert await bambu_ftp.delete_file_async(IP_B, CODE, JOB) == bambu_ftp.DeleteResult.NOT_FOUND
        gated.assert_not_awaited()
