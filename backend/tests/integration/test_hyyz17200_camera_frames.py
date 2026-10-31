"""The cam wall's frame cache: answers at once and keeps the last good frame."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.hyyz17200 import camera_frames

JPEG_A = b"\xff\xd8" + b"A" * 200 + b"\xff\xd9"
JPEG_B = b"\xff\xd8" + b"B" * 200 + b"\xff\xd9"

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _url(printer_id: int, interval: int = 30) -> str:
    return f"/api/v1/hyyz17200/printers/{printer_id}/camera/snapshot-cached?interval={interval}"


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _Camera:
    """Stands in for the printer: answers with what ``frames`` holds next."""

    def __init__(self):
        self.frames: list[bytes | None] = []
        self.calls = 0

    async def capture(self, *, output_path, **_kwargs) -> bool:
        self.calls += 1
        frame = self.frames.pop(0) if self.frames else None
        if frame is None:
            return False
        output_path.write_bytes(frame)
        return True


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(camera_frames, "_now", clock)
    monkeypatch.setattr(camera_frames, "_capture_slots", asyncio.Semaphore(camera_frames.MAX_CONCURRENT_CAPTURES))
    camera_frames._entries.clear()
    yield clock
    for printer_id in list(camera_frames._entries):
        camera_frames.forget(printer_id)


@pytest.fixture
def camera():
    camera = _Camera()
    with patch("backend.app.api.routes.camera.capture_camera_frame", side_effect=camera.capture):
        yield camera


async def _captured(printer_id: int) -> None:
    task = camera_frames._entries[printer_id].task
    if task is not None:
        await task


async def _printer_with_frame(async_client: AsyncClient, printer_factory, camera: _Camera):
    printer = await printer_factory(model="P1S")
    camera.frames = [JPEG_A]
    await async_client.get(_url(printer.id))
    await _captured(printer.id)
    return printer


class TestFrames:
    async def test_answers_at_once_then_serves_the_capture(self, async_client, printer_factory, camera):
        printer = await printer_factory(model="P1S")
        camera.frames = [JPEG_A]

        first = await async_client.get(_url(printer.id))
        assert first.status_code == 204
        await _captured(printer.id)

        second = await async_client.get(_url(printer.id))
        assert second.status_code == 200
        assert second.content == JPEG_A
        assert second.headers["content-type"] == "image/jpeg"
        assert second.headers["cache-control"] == "no-store"

    async def test_a_failed_capture_keeps_the_last_frame(self, async_client, printer_factory, camera, clock):
        printer = await _printer_with_frame(async_client, printer_factory, camera)

        clock.now += 40
        await async_client.get(_url(printer.id))
        await _captured(printer.id)
        response = await async_client.get(_url(printer.id))

        assert camera.calls == 2
        assert response.status_code == 200
        assert response.content == JPEG_A
        assert response.headers["x-hyyz17200-frame-age"] == "40"
        assert response.headers["x-hyyz17200-capture-failures"] == "1"

    async def test_a_new_capture_replaces_the_frame(self, async_client, printer_factory, camera, clock):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        camera.frames = [JPEG_B]

        clock.now += 40
        await async_client.get(_url(printer.id))
        await _captured(printer.id)
        response = await async_client.get(_url(printer.id))

        assert response.content == JPEG_B
        assert response.headers["x-hyyz17200-frame-age"] == "0"
        assert response.headers["x-hyyz17200-capture-failures"] == "0"

    async def test_an_unchanged_frame_is_not_sent_again(self, async_client, printer_factory, camera):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        etag = (await async_client.get(_url(printer.id))).headers["etag"]

        response = await async_client.get(_url(printer.id), headers={"If-None-Match": etag})

        assert response.status_code == 304
        assert response.content == b""
        assert "x-hyyz17200-frame-age" in response.headers

    async def test_what_is_not_a_jpeg_is_not_kept(self, async_client, printer_factory, camera, clock):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        camera.frames = [b"<html>not a picture</html>"]

        clock.now += 40
        await async_client.get(_url(printer.id))
        await _captured(printer.id)
        response = await async_client.get(_url(printer.id))

        assert response.content == JPEG_A
        assert response.headers["x-hyyz17200-capture-failures"] == "1"

    async def test_uses_a_running_live_view_rather_than_a_second_connection(
        self, async_client, printer_factory, camera
    ):
        printer = await printer_factory(model="P1S")
        with (
            patch("backend.app.api.routes.camera._active_chamber_streams", {f"{printer.id}-fanout": MagicMock()}),
            patch("backend.app.api.routes.camera._last_frames", {printer.id: JPEG_B}),
        ):
            await async_client.get(_url(printer.id))
            await _captured(printer.id)

        response = await async_client.get(_url(printer.id))

        assert camera.calls == 0
        assert response.content == JPEG_B


class TestCaptureRate:
    async def test_asking_often_captures_once_per_interval(self, async_client, printer_factory, camera, clock):
        printer = await _printer_with_frame(async_client, printer_factory, camera)

        for _ in range(5):
            clock.now += 5
            await async_client.get(_url(printer.id, interval=30))
            await _captured(printer.id)
        assert camera.calls == 1

        clock.now += 5
        await async_client.get(_url(printer.id, interval=30))
        await _captured(printer.id)
        assert camera.calls == 2

    async def test_a_printer_that_keeps_failing_is_tried_less_often(self, async_client, printer_factory, camera, clock):
        printer = await printer_factory(model="P1S")
        attempts = []
        for second in range(0, 200):
            clock.now = 1000.0 + second
            before = camera.calls
            await async_client.get(_url(printer.id, interval=10))
            await _captured(printer.id)
            if camera.calls > before:
                attempts.append(second)

        assert attempts[:5] == [0, 10, 30, 70, 150]

    async def test_a_success_ends_the_longer_wait(self, async_client, printer_factory, camera, clock):
        printer = await printer_factory(model="P1S")
        for _ in range(3):
            await async_client.get(_url(printer.id, interval=10))
            await _captured(printer.id)
            clock.now += 40
        camera.frames = [JPEG_A]
        await async_client.get(_url(printer.id, interval=10))
        await _captured(printer.id)
        calls = camera.calls

        clock.now += 10
        await async_client.get(_url(printer.id, interval=10))
        await _captured(printer.id)

        assert camera.calls == calls + 1

    async def test_captures_a_few_at_a_time(self, async_client, printer_factory):
        printers = [await printer_factory(model="P1S") for _ in range(5)]
        running = 0
        most = 0
        release = asyncio.Event()

        async def slow_camera(*, output_path, **_kwargs) -> bool:
            nonlocal running, most
            running += 1
            most = max(most, running)
            await release.wait()
            running -= 1
            output_path.write_bytes(JPEG_A)
            return True

        with patch("backend.app.api.routes.camera.capture_camera_frame", side_effect=slow_camera):
            for printer in printers:
                response = await async_client.get(_url(printer.id))
                assert response.status_code == 204
            await asyncio.sleep(0.05)
            assert most == camera_frames.MAX_CONCURRENT_CAPTURES

            release.set()
            for printer in printers:
                await _captured(printer.id)

        for printer in printers:
            assert (await async_client.get(_url(printer.id))).content == JPEG_A

    async def test_a_hung_capture_gives_its_slot_back(self, async_client, printer_factory, monkeypatch):
        monkeypatch.setattr(camera_frames, "CAPTURE_DEADLINE_SECONDS", 0.01)
        printer = await printer_factory(model="P1S")

        async def hung_camera(**_kwargs) -> bool:
            await asyncio.sleep(60)
            return True

        with patch("backend.app.api.routes.camera.capture_camera_frame", side_effect=hung_camera):
            await async_client.get(_url(printer.id))
            await _captured(printer.id)

        entry = camera_frames._entries[printer.id]
        assert entry.failures == 1
        assert entry.task is None
        assert camera_frames._capture_slots._value == camera_frames.MAX_CONCURRENT_CAPTURES

    async def test_a_frame_nobody_asked_for_in_an_hour_is_dropped(self, async_client, printer_factory, camera, clock):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        other = await printer_factory(model="P1S")

        clock.now += camera_frames.FORGET_AFTER_SECONDS
        await async_client.get(_url(other.id))
        await _captured(other.id)

        assert printer.id not in camera_frames._entries


class TestAccess:
    async def test_a_deleted_printer_has_no_frame(self, async_client, printer_factory, camera, db_session):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        await db_session.delete(printer)
        await db_session.commit()

        response = await async_client.get(_url(printer.id))

        assert response.status_code == 404
        assert printer.id not in camera_frames._entries

    async def test_an_interval_out_of_range_is_refused(self, async_client, printer_factory):
        printer = await printer_factory(model="P1S")
        assert (await async_client.get(_url(printer.id, interval=1))).status_code == 422
        assert (await async_client.get(_url(printer.id, interval=301))).status_code == 422

    async def _enable_auth(self, async_client: AsyncClient) -> str:
        await async_client.post(
            "/api/v1/auth/setup",
            json={"auth_enabled": True, "admin_username": "frameadmin", "admin_password": "AdminPass1!"},
        )
        login = await async_client.post(
            "/api/v1/auth/login", json={"username": "frameadmin", "password": "AdminPass1!"}
        )
        return login.json()["access_token"]

    async def test_needs_a_camera_token_when_auth_is_on(self, async_client, printer_factory, camera):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        await self._enable_auth(async_client)

        assert (await async_client.get(_url(printer.id))).status_code == 401
        assert (await async_client.get(f"{_url(printer.id)}&token=wrong")).status_code == 401

    async def test_a_camera_token_opens_it(self, async_client, printer_factory, camera):
        printer = await _printer_with_frame(async_client, printer_factory, camera)
        jwt = await self._enable_auth(async_client)
        minted = await async_client.post(
            "/api/v1/printers/camera/stream-token", headers={"Authorization": f"Bearer {jwt}"}
        )

        response = await async_client.get(f"{_url(printer.id)}&token={minted.json()['token']}")

        assert response.status_code == 200
        assert response.content == JPEG_A

    async def test_a_scoped_token_cannot_read_another_printers_frame(self, async_client, printer_factory, camera):
        from backend.tests.integration.test_printer_scope_1727 import _admin_token, _auth, _team_member

        a = await printer_factory(model="P1S")
        b = await _printer_with_frame(async_client, printer_factory, camera)
        admin = await _admin_token(async_client)
        jwt, _ = await _team_member(async_client, admin, "frame_member", [a.id])
        minted = await async_client.post("/api/v1/printers/camera/stream-token", headers=_auth(jwt))

        response = await async_client.get(f"{_url(b.id)}&token={minted.json()['token']}")

        assert response.status_code == 404
        assert response.content != JPEG_A
