"""Keep a printer's camera connected while its light is held (hyyz17200).

The printer's socket is faked; the upstream generator, the fan-out broadcaster
and the snapshot helpers are upstream's own.
"""

import asyncio
import inspect
from types import SimpleNamespace

import pytest

from backend.app.api.routes import camera as camera_routes
from backend.app.hyyz17200 import camera_hold
from backend.app.services import camera_fanout

JPEG = b"\xff\xd8 frame \xff\xd9"


class FakeWriter:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed

    async def wait_closed(self):
        return None


class FakeCamera:
    """The printer's port 6000: counts connections, frames on demand."""

    def __init__(self, monkeypatch):
        self.connections: list[tuple[asyncio.Queue, FakeWriter]] = []
        self.refuse = False

        async def connect(ip_address, access_code, fps=5):
            if self.refuse:
                return None
            reader, writer = asyncio.Queue(), FakeWriter()
            reader.put_nowait(JPEG)
            self.connections.append((reader, writer))
            return reader, writer

        async def read(reader, timeout=10.0):
            return await reader.get()

        monkeypatch.setattr(camera_routes, "generate_chamber_image_stream", connect)
        monkeypatch.setattr(camera_routes, "read_next_chamber_frame", read)

    def open(self) -> list[FakeWriter]:
        return [w for _r, w in self.connections if not w.closed]

    def drop(self):
        """The printer closes the stream."""
        self.connections[-1][0].put_nowait(None)


def printer(pid=1, **kw):
    values = {
        "id": pid,
        "ip_address": "10.0.0.1",
        "access_code": "12345678",
        "model": "A1",
        "external_camera_enabled": False,
        "external_camera_url": None,
    }
    values.update(kw)
    return SimpleNamespace(**values)


async def until(condition, timeout=2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met")
        await asyncio.sleep(0.01)


@pytest.fixture(autouse=True)
async def fresh(monkeypatch):
    monkeypatch.setattr(camera_fanout, "_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(camera_hold, "RETRY_SECONDS", 0.05)
    monkeypatch.setattr(camera_hold, "MAX_RETRY_SECONDS", 0.2)
    printers = {1: printer(1)}

    async def load(pid):
        return printers.get(pid)

    monkeypatch.setattr(camera_hold, "_load", load)
    yield printers
    camera_hold.release_all()
    await camera_fanout.shutdown_all_broadcasters()
    await asyncio.sleep(0.1)
    camera_hold._holds.clear()
    camera_hold._state.clear()


@pytest.fixture
def cam(monkeypatch):
    return FakeCamera(monkeypatch)


class TestHolding:
    @pytest.mark.asyncio
    async def test_the_camera_stays_connected(self, cam):
        camera_hold.hold({1})
        await until(lambda: camera_hold.state(1) == "streaming")

        assert len(cam.open()) == 1
        assert camera_routes.is_stream_active(1)
        # Snapshots and the Obico check take the held frame, not a connection.
        assert camera_routes.live_frame_for_capture(1) == (True, JPEG)
        assert camera_routes.try_get_active_buffered_frame(1) == JPEG

        camera_hold.hold({1})  # every pass asks again
        await asyncio.sleep(0.1)
        assert len(cam.connections) == 1

    @pytest.mark.asyncio
    async def test_a_live_viewer_shares_it(self, cam):
        camera_hold.hold({1})
        await until(lambda: camera_hold.state(1) == "streaming")

        def factory(_event):  # never called: the held upstream is reused
            raise AssertionError("a second upstream")

        viewer = await camera_fanout.get_or_create_broadcaster("printer-1", factory)
        queue = await viewer.subscribe()
        await viewer.unsubscribe(queue)
        # The viewer leaving does not close the camera: the hold still watches.
        result = await camera_routes.stop_camera_stream(printer_id=1, _=None, viewer=None)
        assert result["skipped"] is True
        await asyncio.sleep(0.1)
        assert len(cam.open()) == 1

    @pytest.mark.asyncio
    async def test_letting_go_closes_it(self, cam):
        camera_hold.hold({1})
        await until(lambda: camera_hold.state(1) == "streaming")

        camera_hold.hold(set())
        await until(lambda: not cam.open())
        assert not camera_routes.is_stream_active(1)
        assert camera_hold.held_printer_ids() == set()

    @pytest.mark.asyncio
    async def test_it_reconnects_when_the_printer_drops_it(self, cam):
        camera_hold.hold({1})
        await until(lambda: camera_hold.state(1) == "streaming")

        cam.drop()
        await until(lambda: len(cam.connections) == 2 and camera_hold.state(1) == "streaming")
        assert len(cam.open()) == 1

    @pytest.mark.asyncio
    async def test_a_refused_camera_is_retried_with_backoff(self, cam, monkeypatch):
        cam.refuse = True
        sleeps: list[float] = []
        real_sleep = asyncio.sleep

        async def sleep(seconds):
            sleeps.append(seconds)
            await real_sleep(0.01)

        monkeypatch.setattr(camera_hold, "_sleep", sleep)
        camera_hold.hold({1})
        await until(lambda: len(sleeps) >= 4)
        assert sleeps[:4] == [0.1, 0.2, 0.2, 0.2]
        assert 1 in camera_hold.held_printer_ids()

        cam.refuse = False
        await until(lambda: camera_hold.state(1) == "streaming")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "kind",
        [
            {"model": "X1C"},
            {"external_camera_enabled": True, "external_camera_url": "http://cam"},
        ],
    )
    async def test_only_the_built_in_chamber_camera(self, cam, fresh, kind):
        fresh[1] = printer(1, **kind)
        camera_hold.hold({1})
        await until(lambda: (camera_hold.state(1) or "").startswith("skipped"))
        camera_hold.hold({1})
        await asyncio.sleep(0.05)
        assert cam.connections == []
        assert camera_hold.held_printer_ids() == set()


class TestUpstreamContracts:
    def test_the_live_view_uses_the_same_upstream(self):
        source = inspect.getsource(camera_routes.camera_stream)
        assert 'fanout_key = f"printer-{printer_id}"' in source
        assert "stream_generator = generate_chamber_mjpeg_stream" in source
        assert "upstream_stream_id = _new_fanout_stream_id(printer_id)" in source
        params = inspect.signature(camera_routes.generate_chamber_mjpeg_stream).parameters
        for name in ("ip_address", "access_code", "model", "fps", "stream_id", "disconnect_event", "printer_id"):
            assert name in params

    def test_captures_take_the_live_frame(self):
        from backend.app.services import failure_detection_camera

        assert "is_stream_active(printer_id)" in inspect.getsource(failure_detection_camera.capture_detection_frame)
        assert "live_frame_for_capture(printer_id)" in inspect.getsource(camera_routes._snapshot_response)

    def test_stop_keeps_a_watched_upstream(self):
        source = inspect.getsource(camera_routes.stop_camera_stream)
        assert "if remaining_subscribers >= 1:" in source

    def test_the_broadcaster_api(self):
        assert list(inspect.signature(camera_fanout.iter_subscriber).parameters)[:2] == ["broadcaster", "queue"]
        assert list(inspect.signature(camera_fanout.get_or_create_broadcaster).parameters) == ["key", "factory"]
