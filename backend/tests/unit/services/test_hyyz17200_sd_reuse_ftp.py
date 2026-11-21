"""sd_reuse's rename against the mock FTPS server (listing, delete, RNFR/RNTO).

Here rather than with the other hyyz17200 tests because the server fixtures
live in this directory's conftest. No uploads: files are put in the server's
root directly, so the TLS-close problem of upload tests on Windows does not
apply.
"""

from backend.app.hyyz17200 import sd_reuse

CACHE_FILE = sd_reuse.CACHE_NAME.lstrip("/")


def _rename(source: str, target: str, size: int) -> str:
    return sd_reuse._rename_sync("127.0.0.1", "12345678", "X1C", 10.0, source, target, size, for_dispatch=False)


class TestRename:
    def test_keeps_a_file_and_puts_it_back(self, patch_ftp_port, ftp_root):
        (ftp_root / "job.3mf").write_bytes(b"x" * 100)

        assert _rename("/job.3mf", sd_reuse.CACHE_NAME, 100) == "renamed"
        assert not (ftp_root / "job.3mf").exists()
        assert (ftp_root / CACHE_FILE).read_bytes() == b"x" * 100

        assert _rename(sd_reuse.CACHE_NAME, "/job.3mf", 100) == "renamed"
        assert (ftp_root / "job.3mf").read_bytes() == b"x" * 100
        assert not (ftp_root / CACHE_FILE).exists()

    def test_replaces_the_previous_cache(self, patch_ftp_port, ftp_root):
        (ftp_root / CACHE_FILE).write_bytes(b"old")
        (ftp_root / "job.3mf").write_bytes(b"new!")

        assert _rename("/job.3mf", sd_reuse.CACHE_NAME, 4) == "renamed"
        assert (ftp_root / CACHE_FILE).read_bytes() == b"new!"

    def test_a_missing_file(self, patch_ftp_port, ftp_root):
        assert _rename(sd_reuse.CACHE_NAME, "/job.3mf", 100) == "missing"

    def test_a_different_size_is_not_touched(self, patch_ftp_port, ftp_root):
        (ftp_root / CACHE_FILE).write_bytes(b"x" * 99)

        assert _rename(sd_reuse.CACHE_NAME, "/job.3mf", 100) == "size_mismatch"
        assert (ftp_root / CACHE_FILE).exists()
        assert not (ftp_root / "job.3mf").exists()
