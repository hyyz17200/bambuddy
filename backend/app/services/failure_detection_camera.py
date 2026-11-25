"""Shared camera capture for AI failure detection providers."""

import logging
from collections.abc import Callable

from backend.app.core.database import async_session
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

# hyyz17200: how old a buffered live frame may be for an AI check. An A1 sends
# one every 2-2.5 s while streaming; an older one means the camera stalled while
# the connection stayed up, and checking it again repeats a stale sample.
DETECTION_FRAME_MAX_AGE = 3.0

# hyyz17200: other owners of a printer's camera connection that the gated path
# must not compete with (the fork's camera hold, also while it waits to retry).
_camera_claims: list[Callable[[int], bool]] = []


def register_camera_claim(claim: Callable[[int], bool]) -> None:
    """hyyz17200: ``claim(printer_id)`` True means the camera is someone else's."""
    if claim not in _camera_claims:
        _camera_claims.append(claim)


class DetectionFrameGate:
    """hyyz17200: which buffered live frames one detection provider may use.

    Owned by the provider, so what one provider read does not hide a frame
    from another. A frame qualifies once: it arrived at most ``max_age``
    seconds ago and this gate has not handed it out before.
    """

    def __init__(self, max_age: float = DETECTION_FRAME_MAX_AGE, clock: Callable[[], float] | None = None) -> None:
        self.max_age = max_age
        self._clock = clock
        self._used: dict[int, int] = {}

    def now(self) -> float:
        if self._clock is not None:
            return self._clock()
        from backend.app.api.routes import camera as camera_routes

        return camera_routes._frame_clock()

    def take(self, printer_id: int, sample) -> tuple[bytes | None, str]:
        """The frame to check, or None and why not."""
        if sample is None:
            return None, "no frame buffered yet"
        if sample.seq is None or sample.received_at is None:
            return None, "buffered frame has no arrival time"
        age = self.now() - sample.received_at
        if age > self.max_age:
            return None, f"buffered frame is {age:.1f}s old"
        if self._used.get(printer_id) == sample.seq:
            return None, "buffered frame was checked already"
        self._used[printer_id] = sample.seq
        return sample.frame, "fresh"

    def forget(self, printer_id: int) -> None:
        self._used.pop(printer_id, None)


def _gated_live_frame(printer_id: int, frame_gate: DetectionFrameGate) -> tuple[bool, bytes | None]:
    """hyyz17200: ``(defer, frame)`` for a gated check, as live_frame_for_capture.

    Defers while a live upstream owns the camera, is still dialing it, or a
    claim holds it; then only a fresh, unused buffered frame is returned.
    """
    from backend.app.api.routes.camera import live_frame_sample, shared_camera_busy

    defer, sample = live_frame_sample(printer_id)
    if not defer and not shared_camera_busy(printer_id) and not any(claim(printer_id) for claim in _camera_claims):
        return False, None
    frame, why = frame_gate.take(printer_id, sample)
    if frame is None:
        logger.info(
            "AI failure detection: camera of printer %s is in use by a live stream and %s; "
            "skipping this poll rather than opening another connection",
            printer_id,
            why,
        )
    return True, frame


async def capture_detection_frame(
    printer_id: int,
    *,
    session_factory=async_session,
    timeout: int = 20,
    frame_gate: DetectionFrameGate | None = None,
) -> bytes | None:
    """Capture a JPEG, sharing live camera buffers to avoid competing readers.

    hyyz17200: with ``frame_gate``, a live buffer is used only when its frame is
    fresh and new to that gate; otherwise the poll is skipped (None).
    """
    # Late import to avoid cycles at module load time
    from backend.app.services.camera import capture_camera_frame_bytes
    from backend.app.services.external_camera import capture_frame as capture_external_frame

    async with session_factory() as db:
        printer = await db.get(Printer, printer_id)
    if printer is None:
        raise ValueError(f"Printer {printer_id} not found")

    if frame_gate is not None:  # hyyz17200
        defer, frame = _gated_live_frame(printer_id, frame_gate)
        if defer:
            return frame

    if printer.external_camera_enabled and printer.external_camera_url:
        # Same rule as the built-in branch below, which this used to skip:
        # an external camera is single-reader too, so polling while a viewer
        # is attached just fails (#2707).
        from backend.app.api.routes.camera import live_frame_for_capture

        defer, buffered = live_frame_for_capture(printer_id)
        if defer:
            if buffered:
                return buffered
            logger.info(
                "AI failure detection: viewer attached for printer %s but buffer empty; "
                "skipping this poll to avoid competing camera handle (#2707)",
                printer_id,
            )
            return None
        return await capture_external_frame(
            printer.external_camera_url,
            printer.external_camera_type or "",
            timeout=timeout,
            snapshot_url=printer.external_camera_snapshot_url,
        )

    # Reuse the fan-out broadcaster's buffered frame when a viewer is
    # already watching — avoids opening a second concurrent RTSP socket
    # on printers that allow only one camera connection (e.g. X2D
    # firmware 01.01.00.00; see #1271). Buffered frame is <1s old while
    # a viewer is connected.
    #
    # When a viewer is attached but no frame is buffered yet (startup
    # race, mid-reconnect), we DELIBERATELY skip this poll cycle instead
    # of falling through to capture_camera_frame_bytes. Opening a fresh
    # RTSP/chamber socket would compete with the live viewer and kick
    # the fan-out connection on most firmwares — exactly the freeze
    # reported in #1348. The poll loop retries in ~10s.
    from backend.app.api.routes.camera import is_stream_active, try_get_active_buffered_frame

    if is_stream_active(printer_id):
        buffered = try_get_active_buffered_frame(printer_id)
        if buffered:
            return buffered
        logger.info(
            "AI failure detection: viewer attached for printer %s but buffer empty; skipping this poll to avoid competing camera socket (#1348)",
            printer_id,
        )
        return None

    return await capture_camera_frame_bytes(
        ip_address=printer.ip_address,
        access_code=printer.access_code,
        model=printer.model,
        timeout=timeout,
    )
