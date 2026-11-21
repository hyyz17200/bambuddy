"""Printing the file printed last from the SD card instead of uploading it (sd_reuse.py)."""

import inspect
import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import backend.app.main as main_module
from backend.app.hyyz17200 import enhanced_settings, sd_reuse
from backend.app.services import bambu_ftp, print_scheduler
from backend.tests.integration.test_hyyz17200_printer_intake import _scheduler, farm  # noqa: F401

IP = "10.0.0.1"
CACHE = sd_reuse.CACHE_NAME


@pytest.fixture(autouse=True)
def _clean():
    before = sd_reuse._settings
    sd_reuse._sent.clear()
    yield
    sd_reuse._sent.clear()
    sd_reuse._settings = before


def _enable(on: bool = True) -> None:
    sd_reuse.apply_settings(sd_reuse.SdReuseSettings(enabled=on))


class FakeCard:
    """The printer's SD card root, as ``_rename_sync`` sees it: path -> size."""

    def __init__(self):
        self.files: dict[str, int] = {}
        self.renames: list[tuple[str, str, bool]] = []
        self.fail: str | None = None

    def rename(self, ip, access_code, model, socket_timeout, source, target, size, *, for_dispatch, stop=None):
        if self.fail:
            return self.fail
        if source not in self.files:
            return "missing"
        if self.files[source] != size:
            return "size_mismatch"
        self.files.pop(target, None)
        self.files[target] = self.files.pop(source)
        self.renames.append((source, target, for_dispatch))
        return "renamed"

    def uploader(self) -> AsyncMock:
        async def upload(ip, access_code, local_path, remote_path, *args, **kwargs):
            self.files[remote_path] = Path(local_path).stat().st_size
            return True

        return AsyncMock(side_effect=upload)


@pytest.fixture
def card():
    fake = FakeCard()
    with patch.object(sd_reuse, "_rename_sync", fake.rename):
        yield fake


def _file(tmp_path: Path, name: str, content: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(content)
    return path


async def _send(upload, path: Path, remote: str = "/job.3mf", **kwargs):
    return await upload(IP, "code", path, remote, socket_timeout=5.0, printer_model="A1", **kwargs)


def _printed(card: FakeCard, remote: str = "/job.3mf") -> None:
    """What the after-print rename does, for tests that skip the database."""
    card.files[CACHE] = card.files.pop(remote)
    sd_reuse._sent[IP].cached = True


class TestUpload:
    @pytest.mark.asyncio
    async def test_off_it_uploads_and_remembers_nothing(self, tmp_path, card):
        raw = card.uploader()
        assert await _send(sd_reuse._wrap_upload(raw), _file(tmp_path, "a", b"x" * 100)) is True
        assert raw.await_count == 1
        assert sd_reuse._sent == {}

    @pytest.mark.asyncio
    async def test_an_upload_is_remembered_by_its_hash(self, tmp_path, card):
        _enable()
        path = _file(tmp_path, "a", b"x" * 100)
        await _send(sd_reuse._wrap_upload(card.uploader()), path)

        sent = sd_reuse._sent[IP]
        assert (sent.remote_path, sent.size, sent.cached) == ("/job.3mf", 100, False)
        assert sent.sha256 == sd_reuse.file_sha256(path)

    @pytest.mark.asyncio
    async def test_the_same_file_after_its_print_comes_from_the_card(self, tmp_path, card):
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        path = _file(tmp_path, "a", b"x" * 100)
        await _send(upload, path)
        _printed(card)

        progress = MagicMock()
        assert await _send(upload, _file(tmp_path, "b", b"x" * 100), progress_callback=progress) is True

        assert raw.await_count == 1
        assert card.files == {"/job.3mf": 100}
        assert card.renames[-1] == (CACHE, "/job.3mf", True)
        progress.assert_called_once_with(100, 100)
        assert sd_reuse._sent[IP].cached is False

    @pytest.mark.asyncio
    async def test_a_same_size_edit_is_uploaded(self, tmp_path, card):
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        await _send(upload, _file(tmp_path, "a", b"G1 Y250\n" * 10))
        _printed(card)

        await _send(upload, _file(tmp_path, "b", b"G1 Y260\n" * 10))

        assert raw.await_count == 2
        assert card.renames == []

    @pytest.mark.asyncio
    async def test_another_file_is_uploaded_and_becomes_the_one_remembered(self, tmp_path, card):
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        await _send(upload, _file(tmp_path, "a", b"x" * 100), "/a.3mf")
        _printed(card, "/a.3mf")

        await _send(upload, _file(tmp_path, "b", b"y" * 50), "/b.3mf")

        assert raw.await_count == 2
        assert sd_reuse._sent[IP].remote_path == "/b.3mf"
        assert sd_reuse._sent[IP].cached is False

    @pytest.mark.asyncio
    async def test_only_the_last_file_is_kept(self, tmp_path, card):
        """A then B then A again: A is uploaded twice."""
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        a = _file(tmp_path, "a", b"x" * 100)
        await _send(upload, a, "/a.3mf")
        _printed(card, "/a.3mf")
        await _send(upload, _file(tmp_path, "b", b"y" * 50), "/b.3mf")
        _printed(card, "/b.3mf")

        await _send(upload, a, "/a.3mf")

        assert raw.await_count == 3

    @pytest.mark.asyncio
    async def test_not_printed_yet_means_nothing_cached(self, tmp_path, card):
        """Sent but never finished (the start failed and upstream deleted it): upload."""
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        path = _file(tmp_path, "a", b"x" * 100)
        await _send(upload, path)
        await _send(upload, path)
        assert raw.await_count == 2

    @pytest.mark.asyncio
    @pytest.mark.parametrize("card_state", ["missing", "size_mismatch", "rename_failed", "no_connection"])
    async def test_a_cache_it_cannot_use_means_an_upload(self, tmp_path, card, card_state):
        _enable()
        raw = card.uploader()
        upload = sd_reuse._wrap_upload(raw)
        path = _file(tmp_path, "a", b"x" * 100)
        await _send(upload, path)
        _printed(card)
        if card_state == "missing":
            card.files.clear()
        elif card_state == "size_mismatch":
            card.files[CACHE] = 99
        else:
            card.fail = card_state

        assert await _send(upload, path) is True

        assert raw.await_count == 2
        assert sd_reuse._sent[IP].cached is False

    @pytest.mark.asyncio
    async def test_a_failed_upload_leaves_nothing_to_reuse(self, tmp_path, card):
        _enable()
        upload = sd_reuse._wrap_upload(AsyncMock(return_value=False))
        assert await _send(upload, _file(tmp_path, "a", b"x" * 100)) is False
        assert sd_reuse._sent == {}

    @pytest.mark.asyncio
    async def test_a_broken_check_still_uploads(self, tmp_path, card):
        _enable()
        raw = card.uploader()
        with patch.object(sd_reuse, "file_sha256", side_effect=OSError("disk")):
            assert await _send(sd_reuse._wrap_upload(raw), _file(tmp_path, "a", b"x")) is True
        assert raw.await_count == 1


async def _archive_id(ctx, item_id: int) -> int:
    return (await ctx.item(item_id)).archive_id


class TestAfterPrint:
    """The cleanup wrapper renames our file instead of letting upstream delete it."""

    async def _run(self, ctx, printer_id, subtask, archive_id, delete):
        with (
            patch("backend.app.core.database.async_session", ctx.session_maker),
            patch.object(main_module, "async_session", ctx.session_maker),
            patch.object(bambu_ftp, "delete_file_async", delete),
        ):
            await main_module._cleanup_sd_card_after_print(printer_id, subtask, archive_id, logging.getLogger())

    @pytest.mark.asyncio
    async def test_our_file_is_kept_under_the_cache_name(self, farm, card):  # noqa: F811
        _enable()
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        card.files["/job-0.3mf"] = 15
        sd_reuse._sent[IP] = sd_reuse._Sent("/job-0.3mf", "hash", 15)

        delete = AsyncMock(return_value=bambu_ftp.DeleteResult.DELETED)
        await self._run(farm, printer_id, "job-0", await _archive_id(farm, item_id), delete)

        assert card.files == {CACHE: 15}
        assert card.renames == [("/job-0.3mf", CACHE, False)]
        assert sd_reuse._sent[IP].cached is True
        delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_without_an_archive_the_job_name_decides(self, farm, card):  # noqa: F811
        _enable()
        printer_id = await farm.add_printer("A1-01")
        card.files["/My_Part.3mf"] = 15
        sd_reuse._sent[IP] = sd_reuse._Sent("/My_Part.3mf", "hash", 15)

        await self._run(farm, printer_id, "My Part", None, AsyncMock())

        assert card.files == {CACHE: 15}

    @pytest.mark.asyncio
    async def test_a_print_that_is_not_ours_goes_to_upstream(self, farm, card):  # noqa: F811
        _enable()
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        sd_reuse._sent[IP] = sd_reuse._Sent("/other.3mf", "hash", 15)

        delete = AsyncMock(return_value=bambu_ftp.DeleteResult.DELETED)
        await self._run(farm, printer_id, "job-0", await _archive_id(farm, item_id), delete)

        assert card.renames == []
        assert delete.await_args_list[0].args[2] == "/job-0.3mf"

    @pytest.mark.asyncio
    async def test_a_failed_rename_is_deleted_and_forgotten(self, farm, card):  # noqa: F811
        _enable()
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        card.fail = "rename_failed"
        sd_reuse._sent[IP] = sd_reuse._Sent("/job-0.3mf", "hash", 15)

        delete = AsyncMock(return_value=bambu_ftp.DeleteResult.DELETED)
        await self._run(farm, printer_id, "job-0", await _archive_id(farm, item_id), delete)

        assert delete.await_count >= 1
        assert IP not in sd_reuse._sent

    @pytest.mark.asyncio
    async def test_a_file_printing_again_is_left_alone(self, farm, card):  # noqa: F811
        """Started again from the printer's screen before the cleanup ran."""
        _enable()
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        card.files["/job-0.3mf"] = 15
        sd_reuse._sent[IP] = sd_reuse._Sent("/job-0.3mf", "hash", 15)
        running = MagicMock(state="RUNNING", gcode_file="job-0.3mf", subtask_name="job-0")

        with patch.object(sd_reuse.printer_manager, "get_status", MagicMock(return_value=running)):
            await self._run(farm, printer_id, "job-0", await _archive_id(farm, item_id), AsyncMock())

        assert card.renames == []
        assert card.files == {"/job-0.3mf": 15}

    @pytest.mark.asyncio
    async def test_off_it_is_upstream(self, farm, card):  # noqa: F811
        printer_id = await farm.add_printer("A1-01")
        item_id = await farm.add_item(printer_id=printer_id)
        sd_reuse._sent[IP] = sd_reuse._Sent("/job-0.3mf", "hash", 15)

        delete = AsyncMock(return_value=bambu_ftp.DeleteResult.DELETED)
        await self._run(farm, printer_id, "job-0", await _archive_id(farm, item_id), delete)

        assert card.renames == []
        assert delete.await_args_list[0].args[2] == "/job-0.3mf"


class TestDispatch:
    """Through the real scheduler: the second job of a file is not uploaded."""

    @pytest.mark.asyncio
    async def test_the_second_job_of_a_file_starts_from_the_card(self, farm, card):  # noqa: F811
        _enable()
        printer_id = await farm.add_printer("A1-01")
        first = await farm.add_item(printer_id=printer_id)

        async with _scheduler(farm) as scheduler:
            raw = card.uploader()
            with (
                patch.object(print_scheduler, "upload_file_async", sd_reuse._wrap_upload(raw)),
                patch.object(main_module, "async_session", farm.session_maker),
                patch.object(bambu_ftp, "delete_file_async", AsyncMock()),
            ):
                await scheduler._dispatch_one(first, printer_id)
                assert (await farm.item(first)).status == "printing"
                assert card.files == {"/job-0.3mf": 15}

                await main_module._cleanup_sd_card_after_print(
                    printer_id, "job-0", await _archive_id(farm, first), logging.getLogger()
                )
                assert card.files == {CACHE: 15}

                second = await farm.add_item(printer_id=printer_id)
                await scheduler._dispatch_one(second, printer_id)
                start = print_scheduler.printer_manager.start_print

        assert (await farm.item(second)).status == "printing"
        assert raw.await_count == 1
        assert card.files == {"/job-0.3mf": 15}
        assert [call.args[1] for call in start.call_args_list] == ["job-0.3mf", "job-0.3mf"]


class TestUpstreamContracts:
    def test_the_wrappers_are_installed(self):
        assert print_scheduler.upload_file_async.hyyz17200 is True
        assert print_scheduler.delete_file_async.hyyz17200 is True
        assert bambu_ftp.delete_file_async.hyyz17200 is True
        assert main_module._cleanup_sd_card_after_print.hyyz17200 is True

    def test_the_scheduler_deletes_through_its_module_name(self):
        """The delete before the upload, and those after a failed start, are gated."""
        source = inspect.getsource(print_scheduler.PrintScheduler._start_print)
        assert source.count("await delete_file_async(") >= 2
        params = list(inspect.signature(bambu_ftp.delete_file_async.__wrapped__).parameters)
        assert params == [
            "ip_address",
            "access_code",
            "remote_path",
            "socket_timeout",
            "printer_model",
            "timeout",
            "respect_handshake_cooloff",
        ]
        assert params == list(inspect.signature(sd_reuse._gated_delete).parameters)

    def test_the_cleanup_imports_its_delete_when_it_runs(self):
        """So it picks up the gated ``bambu_ftp.delete_file_async``."""
        original = main_module._cleanup_sd_card_after_print.__wrapped__
        assert "from backend.app.services.bambu_ftp import DeleteResult, delete_file_async" in inspect.getsource(
            original
        )

    def test_the_upload_stops_when_its_callback_raises(self):
        """A cancelled gated upload stops at its next chunk through the progress callback."""
        source = inspect.getsource(bambu_ftp.BambuFTPClient.upload_file)
        assert "progress_callback(uploaded, file_size)" in source
        assert "callback_exception = e" in source
        assert "_ftp_executor" in dir(bambu_ftp)

    def test_the_scheduler_uploads_through_its_module_name(self):
        source = inspect.getsource(print_scheduler.PrintScheduler._start_print)
        assert "await upload_file_async(" in source
        assert re.search(r"with_ftp_retry\(\s*upload_file_async,", source)
        assert "progress_callback=progress_bridge" in source
        # The file is uploaded under the name the print command and the cleanup use.
        assert "remote_filename = derive_remote_filename(filename)" in source
        assert 'remote_path = f"/{remote_filename}"' in source

    def test_the_upload_parameters(self):
        params = list(inspect.signature(bambu_ftp.upload_file_async).parameters)
        assert params[:4] == ["ip_address", "access_code", "local_path", "remote_path"]
        assert {"progress_callback", "socket_timeout", "printer_model"} <= set(params)

    def test_the_cleanup(self):
        original = main_module._cleanup_sd_card_after_print.__wrapped__
        assert list(inspect.signature(original).parameters) == ["printer_id", "subtask_name", "archive_id", "logger"]
        assert "derive_remote_filename(archive_filename)" in inspect.getsource(original)
        close_out = inspect.getsource(main_module._close_out_print)
        assert "_cleanup_sd_card_after_print(printer_id, subtask_name, archive_id, logger)" in close_out

    def test_the_main_helpers(self):
        for name in ("_sd_files_in_use", "_subtask_name_from_filename", "_subtask_names_match"):
            assert callable(getattr(main_module, name))

    def test_the_ftp_client(self):
        params = inspect.signature(bambu_ftp.BambuFTPClient.__init__).parameters
        assert {"timeout", "printer_model", "respect_handshake_cooloff"} <= set(params)
        client = bambu_ftp.BambuFTPClient("127.0.0.1", "code")
        assert client._ftp is None
        for name in ("connect", "disconnect", "list_files", "delete_file"):
            assert callable(getattr(client, name))

    def test_the_setting_is_off_by_default(self):
        assert enhanced_settings.SECTIONS["sd_reuse"] is sd_reuse.SdReuseSettings
        assert enhanced_settings.APPLY["sd_reuse"] is sd_reuse.apply_settings
        assert sd_reuse.SdReuseSettings().enabled is False
        assert not sd_reuse.CACHE_NAME.endswith((".3mf", ".gcode"))
