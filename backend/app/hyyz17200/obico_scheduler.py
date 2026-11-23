"""Obico checks on each printer's own clock, a few at a time.

Upstream's loop checks the monitored printers one after another and then sleeps
the interval, so a printer's period is the interval plus every other printer's
check. On the farm (2026-11-23: 46 A1 printing, interval 5s) every check took
3.0s, nearly all of it waiting on the printer's camera, and each printer was
checked every 142s. Its 30 warmup frames took 71 minutes.

Here a printer is due one interval after its previous check started. A due
printer starts as soon as one of ``max_concurrent`` slots is free, earliest due
first. A printer never has two checks at once: a check that overruns its
interval is followed by one more check, not by the ones it missed. The check is
upstream's ``_check_printer``, unchanged; only its scheduling is replaced, on
the singleton's instance (upstream's tests build their own instances).

Because checks now overlap, a result can come back after its print ended or the
settings changed. An action is dropped, and the print left un-acted so a later
check can decide again, unless the printer is still running the print the check
started on, nothing restarted, and the action and sensitivity it was decided
with are still the saved ones. An action that passes runs as a task of its
own: a check cancelled later does not cut a pause short, and a slow
notification does not hold a slot. stop() cancels checks and actions, so
nothing acts once detection is off.

``enabled = False`` (Enhanced Settings) goes back to upstream's loop, for
comparing and as a way out. The action check and the timing apply in both.

``skip_preparation``: upstream checks whenever the printer says RUNNING, which
on Bambu printers includes the whole start sequence before layer 1 (bed
leveling, preheating, nozzle wipe, purge line, flow calibration). Those frames
show no print, yet count toward the print's 30 warmup frames and its baseline.
With the switch on (the default) a printer is first checked on layer 1. Before
layer 1 is upstream's own rule from #3211, as main._progress_milestone_to_notify
applies it; a printer that reports neither a layer count nor a stage is checked
as before.
"""

import asyncio
import functools
import logging
import random
import ssl
import time
from collections import deque
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT = 8
MAX_CONCURRENT_RANGE = (1, 32)
# Upstream's floor for the interval. Module-level so tests can run faster.
MIN_INTERVAL = 5.0
# Capture (20s) and the ML request (30s per step) have their own timeouts. This
# only makes sure a slot comes back.
CHECK_DEADLINE = 90.0
# A printer whose checks keep failing is checked less often, up to this.
BACKOFF_CAP = 60.0
# No verdict for this long (and at least STALE_INTERVALS intervals) while the
# printer runs or is unreachable is reported as an error, not the old verdict.
STALE_MIN = 60.0
STALE_INTERVALS = 4
SETTINGS_TTL = 5.0
# How often printer states are read when no check is due sooner: a print that
# starts, pauses or ends is seen within this.
STATUS_SECONDS = 1.0
# main._NO_PREPARATION_STAGES: stg_cur 0 is "Printing", -1 and 255 "no stage".
NO_PREPARATION_STAGES = frozenset({0, -1, 255})
SUMMARY_SECONDS = 60.0
HISTORY = 20


class ObicoSchedulerSettings(BaseModel):
    """The Enhanced Settings' AI detection section."""

    # False = upstream's loop: one printer after another, then the interval.
    enabled: bool = True
    max_concurrent: int = Field(default=DEFAULT_MAX_CONCURRENT, ge=MAX_CONCURRENT_RANGE[0], le=MAX_CONCURRENT_RANGE[1])
    # True = no checks before layer 1: the start sequence prints nothing.
    skip_preparation: bool = True


# ---- one TLS context for obico_detection's httpx clients ----

_tls: ssl.SSLContext | None = None


def _tls_context() -> ssl.SSLContext:
    """httpx's default context, built once. Building it loads the CA bundle,
    synchronously: 150-170 ms on Windows (measured 2026-11-23)."""
    global _tls
    if _tls is None:
        _tls = httpx.create_ssl_context()
    return _tls


class _SharedTlsHttpx:
    """``httpx`` as obico_detection sees it, except that a client without its
    own ``verify`` reuses one TLS context. Upstream makes a client per check;
    with checks side by side, building a context each time alone would hold
    the event loop for most of every second."""

    hyyz17200 = True

    def __getattr__(self, name: str):
        return getattr(httpx, name)

    def AsyncClient(self, *args, **kwargs):  # noqa: N802 - stands in for httpx.AsyncClient
        kwargs.setdefault("verify", _tls_context())
        return httpx.AsyncClient(*args, **kwargs)


# ---- state ----


@dataclass
class _Track:
    """One printer: its schedule while it prints, and its numbers."""

    active: bool = False  # printing and monitored: checked, or will be
    due: float | None = None  # monotonic; None = not scheduled
    task: asyncio.Task | None = None
    overran: bool = False  # this check already counted as overrunning
    waiting: bool = False  # this due time already counted as waiting for a slot
    failures: int = 0  # in a row
    checks: int = 0
    ok: int = 0
    failed: int = 0
    overruns: int = 0
    waits: int = 0
    dropped_actions: int = 0
    lag: float | None = None  # how late the last check started
    capture: float | None = None
    ml: float | None = None
    total: float | None = None
    capture_avg: float | None = None
    ml_avg: float | None = None
    total_avg: float | None = None
    starts: deque = field(default_factory=lambda: deque(maxlen=HISTORY))
    oks: deque = field(default_factory=lambda: deque(maxlen=HISTORY))


@dataclass
class _Check:
    """What a check started on, for timing it and for the action check."""

    printer_id: int
    key: str
    job_id: str | None
    epoch: int
    generation: int
    action: str | None
    sensitivity: str | None
    started: float
    track: _Track
    capture: float | None = None
    got_frame: bool = False


_CHECK: ContextVar[_Check | None] = ContextVar("hyyz17200_obico_check", default=None)


def _print_key(status) -> str:
    """Upstream's key for a print (``_check_printer``)."""
    return getattr(status, "task_name", None) or getattr(status, "subtask_name", "") or ""


def _preparing(status) -> bool:
    """Still before layer 1, by upstream's rule (#3211): a layer count but no
    layer yet, or with no count, a preparation stage. A printer that reports
    neither counts as printing."""
    if (getattr(status, "layer_num", 0) or 0) >= 1:
        return False
    if (getattr(status, "total_layers", 0) or 0) > 0:
        return True
    stage = getattr(status, "stg_cur", -1)
    return stage is not None and stage not in NO_PREPARATION_STAGES


def _ema(old: float | None, new: float | None) -> float | None:
    if new is None:
        return old
    return new if old is None else old * 0.8 + new * 0.2


def _avg_gap(times: deque) -> float | None:
    return (times[-1] - times[0]) / (len(times) - 1) if len(times) >= 2 else None


def _interval(settings: dict) -> float:
    try:
        return max(MIN_INTERVAL, float(settings.get("poll_interval", 10)))
    except (TypeError, ValueError):
        return max(MIN_INTERVAL, 10.0)


class ObicoScheduler:
    """Replaces the scheduling of one ObicoDetectionService instance."""

    def __init__(self, service, settings: ObicoSchedulerSettings | None = None):
        self.service = service
        settings = settings or ObicoSchedulerSettings()
        self.enabled = settings.enabled
        self.max_concurrent = settings.max_concurrent
        self.skip_preparation = settings.skip_preparation
        self._preparing_now = 0
        self._orig: dict[str, Callable] = {}
        self._tracks: dict[int, _Track] = {}
        self._actions: set[asyncio.Task] = set()
        # Bumped when a printer's print ends or the printer goes: a result from
        # before must not act.
        self._epochs: dict[int, int] = {}
        # Bumped by stop/refresh: nothing from before may act.
        self._generation = 0
        # printer_id -> when its current state last had a verdict (watchdog)
        self._last_ok: dict[int, float] = {}
        self._wake: asyncio.Event | None = None
        self._mode: str | None = None
        self._settings: dict | None = None
        self._settings_until = 0.0
        self._recent: deque = deque()  # (end, ok, capture, ml, total) of the last minute
        self._interval: float | None = None
        self._minute = {"waits": 0, "overruns": 0, "peak": 0, "dropped": 0}
        self._next_summary = 0.0

    # ---- installing ----

    def attach(self) -> None:
        svc = self.service
        for name in (
            "_loop",
            "_check_printer",
            "_capture_frame",
            "_dispatch_action",
            "_end_print",
            "forget_printer",
            "stop",
            "refresh_settings",
        ):
            self._orig[name] = getattr(svc, name)
        svc._loop = self._loop
        svc._check_printer = self._check_printer
        svc._capture_frame = self._capture_frame
        svc._dispatch_action = self._dispatch_action
        svc._end_print = self._end_print
        svc.forget_printer = self.forget_printer
        svc.stop = self.stop
        svc.refresh_settings = self.refresh_settings
        svc.hyyz17200_scheduler = self

    def configure(self, value: ObicoSchedulerSettings) -> None:
        self.enabled = value.enabled
        self.max_concurrent = value.max_concurrent
        self.skip_preparation = value.skip_preparation
        self._poke()

    def _poke(self) -> None:
        if self._wake is not None:
            self._wake.set()

    # ---- lifecycle (wrapping upstream's) ----

    def stop(self) -> None:
        self._cancel(actions=True)
        self._orig["stop"]()

    async def refresh_settings(self) -> None:
        pending = self._cancel(actions=True)
        await self._orig["refresh_settings"]()  # calls stop(), clears, restarts
        await self._settle(pending)

    def forget_printer(self, printer_id: int) -> None:
        self._unschedule(printer_id)
        self._tracks.pop(printer_id, None)
        self._orig["forget_printer"](printer_id)

    def _end_print(self, printer_id: int) -> None:
        self._unschedule(printer_id)
        self._orig["_end_print"](printer_id)

    def _cancel(self, *, actions: bool) -> list[asyncio.Task]:
        """Cancel every check (and action): nothing started before may act."""
        self._generation += 1
        current = asyncio.current_task() if self._in_loop() else None
        tasks = []
        for track in self._tracks.values():
            if track.task is not None and track.task is not current:
                tasks.append(track.task)
            track.active = False
            track.due = None
            track.overran = track.waiting = False
            track.failures = 0
            track.starts.clear()
            track.oks.clear()
        if actions:
            tasks += [task for task in self._actions if task is not current]
        for task in tasks:
            task.cancel()
        self._last_ok.clear()
        self._settings = None
        return tasks

    def _unschedule(self, printer_id: int) -> None:
        """The printer's print is over (or the printer is gone or deselected)."""
        self._epochs[printer_id] = self._epochs.get(printer_id, 0) + 1
        self._last_ok.pop(printer_id, None)
        track = self._tracks.get(printer_id)
        if track is None:
            return
        if track.task is not None and (not self._in_loop() or track.task is not asyncio.current_task()):
            track.task.cancel()  # the done callback clears it
        track.active = False
        track.due = None
        track.overran = track.waiting = False
        track.failures = 0
        track.starts.clear()
        track.oks.clear()

    @staticmethod
    def _in_loop() -> bool:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return False
        return True

    @staticmethod
    async def _settle(tasks: list[asyncio.Task]) -> None:
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ---- the loop ----

    async def _loop(self) -> None:
        svc = self.service
        self._wake = asyncio.Event()
        while True:
            try:
                mode = "concurrent" if self.enabled else "sequential"
                if mode != self._mode:
                    # Upstream's loop must not overlap checks still running here.
                    await self._settle(self._cancel(actions=False))
                    self._mode = mode
                if mode == "sequential":
                    await self._sequential_round()
                    continue
                settings = await self._current_settings()
                if not settings["enabled"] or not settings["ml_url"]:
                    await self._settle(self._cancel(actions=True))
                    await self._sleep(_interval(settings))
                    continue
                self._wake.clear()
                await self._sleep(self._tick(settings))
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Obico detection loop error: %s", e)
                svc._last_error = str(e) or type(e).__name__
                await asyncio.sleep(30)

    async def _sleep(self, seconds: float) -> None:
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except TimeoutError:
            pass

    async def _current_settings(self) -> dict:
        now = time.monotonic()
        if self._settings is None or now >= self._settings_until:
            self._settings = await self.service._load_settings()
            self._settings_until = now + SETTINGS_TTL
        return self._settings

    async def _sequential_round(self) -> None:
        """One round of upstream's loop: every printer in turn, then the interval."""
        svc = self.service
        settings = await svc._load_settings()
        self._settings = settings
        self._interval = _interval(settings)
        if settings["enabled"] and settings["ml_url"]:
            await svc._poll_once(settings)
            self._summarize(time.monotonic(), _interval(settings))
        self._wake.clear()
        await self._sleep(_interval(settings))

    def _tick(self, settings: dict) -> float:
        """Start the checks that are due; return how long to sleep."""
        from backend.app.services.obico_detection import _ENDED_STATES
        from backend.app.services.printer_manager import printer_manager

        svc = self.service
        now = time.monotonic()
        interval = self._interval = _interval(settings)
        monitored = settings["enabled_printers"]
        statuses = printer_manager.get_all_statuses()

        for printer_id in list(self._tracks):
            if printer_id not in statuses or (monitored is not None and printer_id not in monitored):
                self._unschedule(printer_id)

        connected: set[int] = set()
        preparing: set[int] = set()
        due = []
        upcoming = []
        # The same filters as upstream's _poll_once.
        for printer_id, status in list(statuses.items()):
            if monitored is not None and printer_id not in monitored:
                continue
            if not printer_manager.is_connected(printer_id):
                continue
            connected.add(printer_id)
            print_state = getattr(status, "state", None) if status else None
            if print_state != "RUNNING":
                if print_state is None or print_state in _ENDED_STATES:
                    svc._end_print(printer_id)
                continue
            if self.skip_preparation and _preparing(status):
                preparing.add(printer_id)
                continue
            track = self._tracks.setdefault(printer_id, _Track())
            track.active = True
            if track.due is None:
                # Spread printers that start together over one interval.
                track.due = now + self._first_delay(interval)
            if track.task is not None:
                if now >= track.due and not track.overran:
                    track.overran = True
                    track.overruns += 1
                    self._minute["overruns"] += 1
                continue
            if now >= track.due:
                due.append((track.due, printer_id, status))
            else:
                upcoming.append(track.due - now)

        due.sort(key=lambda item: (item[0], item[1]))
        in_flight = self.in_flight()
        for _due, printer_id, status in due:
            track = self._tracks[printer_id]
            if in_flight >= self.max_concurrent:
                if not track.waiting:
                    track.waiting = True
                    track.waits += 1
                    self._minute["waits"] += 1
                continue
            self._spawn(printer_id, track, status, settings, now, interval)
            in_flight += 1
        self._minute["peak"] = max(self._minute["peak"], in_flight)
        self._preparing_now = len(preparing)

        self._watch(statuses, connected, preparing, monitored, now, interval)
        self._summarize(now, interval)

        # A finishing check wakes the loop early, which is what a printer
        # waiting for a slot needs.
        return max(0.0, min([STATUS_SECONDS, *upcoming]))

    def _first_delay(self, interval: float) -> float:
        return random.uniform(0, interval)

    def in_flight(self) -> int:
        return sum(1 for track in self._tracks.values() if track.task is not None)

    def _spawn(self, printer_id: int, track: _Track, status, settings: dict, now: float, interval: float) -> None:
        track.lag = now - track.due
        track.due = now + interval  # from this start, not from the missed one
        track.overran = track.waiting = False
        task = asyncio.create_task(
            self.service._check_printer(printer_id, status, settings), name=f"hyyz17200-obico-{printer_id}"
        )
        track.task = task
        task.add_done_callback(functools.partial(self._check_done, track))

    def _check_done(self, track: _Track, task: asyncio.Task) -> None:
        if track.task is task:
            track.task = None
        if not task.cancelled() and task.exception() is not None:
            logger.error("hyyz17200 obico: check task failed: %r", task.exception())
        self._poke()

    # ---- one check (wrapping upstream's) ----

    async def _check_printer(self, printer_id: int, status, settings: dict) -> None:
        """Upstream's check, timed, with what the action check needs. Also runs
        from upstream's _poll_once in sequential mode."""
        svc = self.service
        if self.skip_preparation and _preparing(status):
            return  # sequential mode: upstream's loop doesn't know about layers
        track = self._tracks.setdefault(printer_id, _Track())
        track.active = True
        check = _Check(
            printer_id=printer_id,
            key=_print_key(status),
            job_id=svc._job_id(status),
            epoch=self._epochs.get(printer_id, 0),
            generation=self._generation,
            action=settings.get("action"),
            sensitivity=settings.get("sensitivity"),
            started=time.monotonic(),
            track=track,
        )
        track.checks += 1
        track.starts.append(check.started)
        before = svc._states.get(printer_id)
        before_count = before.frame_count if before is not None else 0
        token = _CHECK.set(check)
        outcome = "cancelled"
        try:
            await asyncio.wait_for(self._orig["_check_printer"](printer_id, status, settings), CHECK_DEADLINE)
            after = svc._states.get(printer_id)
            ok = (
                after is not None
                and printer_id not in svc._errors
                and (after is not before or after.frame_count > before_count)
            )
            outcome = "ok" if ok else "failed"
        except TimeoutError as e:
            if time.monotonic() - check.started >= CHECK_DEADLINE:
                reason = f"Obico check of printer {printer_id} took longer than {CHECK_DEADLINE:.0f}s"
            else:
                reason = f"Obico check of printer {printer_id} failed: {e or type(e).__name__}"
            svc._no_verdict(printer_id, reason)
            outcome = "failed"
        except Exception as e:
            # Upstream's loop paused every printer for 30s on this; one printer
            # is enough.
            svc._no_verdict(printer_id, f"Obico check of printer {printer_id} failed: {e or type(e).__name__}")
            outcome = "failed"
        finally:
            _CHECK.reset(token)
            self._record(check, outcome, settings)

    async def _capture_frame(self, printer_id: int) -> bytes | None:
        check = _CHECK.get()
        started = time.monotonic()
        frame = None
        try:
            frame = await self._orig["_capture_frame"](printer_id)
            return frame
        finally:
            if check is not None and check.printer_id == printer_id:
                check.capture = time.monotonic() - started
                check.got_frame = frame is not None

    def _record(self, check: _Check, outcome: str, settings: dict) -> None:
        if outcome == "cancelled":
            return
        end = time.monotonic()
        track = check.track
        total = end - check.started
        # The rest of the check after the frame: mostly the ML request, with
        # any wait for Obico's worker.
        ml = max(0.0, total - (check.capture or 0.0)) if check.got_frame else None
        track.total, track.capture, track.ml = total, check.capture, ml
        track.total_avg = _ema(track.total_avg, total)
        track.capture_avg = _ema(track.capture_avg, check.capture)
        track.ml_avg = _ema(track.ml_avg, ml)
        current = self._tracks.get(check.printer_id) is track
        if outcome == "ok":
            track.ok += 1
            track.oks.append(end)
            track.failures = 0
            if current and check.printer_id in self.service._states:
                self._last_ok[check.printer_id] = end
        else:
            track.failed += 1
            track.failures += 1
            if current and track.due is not None:
                interval = _interval(settings)
                backoff = min(interval * 2 ** (track.failures - 1), max(interval, BACKOFF_CAP))
                track.due = max(track.due, check.started + backoff)
        self._recent.append((end, outcome == "ok", check.capture, ml, total))
        logger.debug(
            "hyyz17200 obico: printer %s check %s in %.2fs (capture %s, ML %s), started %s late",
            check.printer_id,
            outcome,
            total,
            "-" if check.capture is None else f"{check.capture:.2f}s",
            "-" if ml is None else f"{ml:.2f}s",
            "-" if track.lag is None else f"{track.lag:.2f}s",
        )

    # ---- acting on a result ----

    async def _dispatch_action(self, printer_id: int, action: str, task_name: str, score: float, frame=None):
        svc = self.service
        check = _CHECK.get()
        if check is None or check.printer_id != printer_id:
            return await self._orig["_dispatch_action"](printer_id, action, task_name, score, frame)
        # Upstream updates the state and calls this with no await in between,
        # so this is the state the check just updated.
        state = svc._states.get(printer_id)
        try:
            reason = self._stale(check, await svc._load_settings(), action)
        except asyncio.CancelledError:
            self._not_acted(printer_id, state)
            raise
        except Exception as e:
            reason = f"could not read the settings ({type(e).__name__})"
        if reason:
            check.track.dropped_actions += 1
            self._minute["dropped"] += 1
            self._not_acted(printer_id, state)
            logger.warning(
                "hyyz17200 obico: printer %s: dropped the %s action of a check on %r: %s",
                printer_id,
                action,
                check.key,
                reason,
            )
            return
        # No await between the check above and starting the action. The action
        # is its own task: cancelling the check must not cut a pause short, and
        # a slow notification must not hold the check's slot.
        task = asyncio.create_task(
            self._orig["_dispatch_action"](printer_id, action, task_name, score, frame),
            name=f"hyyz17200-obico-action-{printer_id}",
        )
        self._actions.add(task)
        task.add_done_callback(self._action_done)

    def _action_done(self, task: asyncio.Task) -> None:
        self._actions.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("hyyz17200 obico: action task failed: %r", task.exception())

    def _not_acted(self, printer_id: int, state) -> None:
        """Upstream marked the print as acted on before calling the action. It
        wasn't, so a later check of the same print may act."""
        if state is not None and self.service._states.get(printer_id) is state:
            self.service._action_fired[printer_id] = False

    def _stale(self, check: _Check, settings: dict, action: str) -> str | None:
        """Why the check's result may not act now, or None."""
        from backend.app.services.printer_manager import printer_manager

        printer_id = check.printer_id
        if check.generation != self._generation:
            return "detection was restarted"
        if self._epochs.get(printer_id, 0) != check.epoch:
            return "the print ended"
        if not settings["enabled"] or not settings["ml_url"]:
            return "detection is off"
        monitored = settings["enabled_printers"]
        if monitored is not None and printer_id not in monitored:
            return "the printer is no longer monitored"
        if settings["action"] != action:
            return "the action setting changed"
        if settings["sensitivity"] != check.sensitivity:
            return "the sensitivity changed"
        status = printer_manager.get_status(printer_id)
        if status is None:
            return "the printer is gone"
        state = getattr(status, "state", None)
        if state != "RUNNING":
            return f"the printer is {state or 'in an unknown state'}"
        if _print_key(status) != check.key:
            return "another print started"
        job_id = self.service._job_id(status)
        if job_id and check.job_id and job_id != check.job_id:
            return "another print started"
        return None

    # ---- stale verdicts ----

    def _watch(
        self, statuses: dict, connected: set[int], preparing: set[int], monitored, now: float, interval: float
    ) -> None:
        """A printer that should be checked but has had no verdict for a while
        shows an error instead of its last verdict."""
        svc = self.service
        stale_after = max(STALE_MIN, STALE_INTERVALS * interval)
        for printer_id in list(self._last_ok):
            if printer_id not in svc._states:
                del self._last_ok[printer_id]
        for printer_id in list(svc._states):
            if monitored is not None and printer_id not in monitored:
                continue
            since = self._last_ok.setdefault(printer_id, now)
            status = statuses.get(printer_id)
            if printer_id in connected and (getattr(status, "state", None) != "RUNNING" or printer_id in preparing):
                # Paused or before layer 1: not checked on purpose, and that
                # time doesn't count.
                self._last_ok[printer_id] = now
                continue
            if printer_id in svc._errors or now - since < stale_after:
                continue
            reason = "the printer is disconnected" if printer_id not in connected else "no check has finished"
            svc._errors[printer_id] = f"No detection result for {int(now - since)}s: {reason}"
            logger.warning(
                "hyyz17200 obico: printer %s has had no detection result for %ds (%s)",
                printer_id,
                int(now - since),
                reason,
            )

    # ---- numbers ----

    def _summarize(self, now: float, interval: float) -> None:
        """One INFO line a minute, so the effect shows without debug logging."""
        while self._recent and self._recent[0][0] < now - SUMMARY_SECONDS:
            self._recent.popleft()
        if now < self._next_summary:
            return
        first = self._next_summary == 0.0
        self._next_summary = now + SUMMARY_SECONDS
        minute, self._minute = self._minute, {"waits": 0, "overruns": 0, "peak": 0, "dropped": 0}
        if first or not self._recent:
            return
        printing = [t for t in self._tracks.values() if t.active]
        periods = sorted(p for p in (_avg_gap(t.starts) for t in printing) if p is not None)

        def avg(index: int) -> str:
            values = [r[index] for r in self._recent if r[index] is not None]
            return f"{sum(values) / len(values):.2f}s" if values else "-"

        logger.info(
            "hyyz17200 obico: %s, %d printers, %d checks in the last minute (%d ok, target %.0f); "
            "median period %s (interval %.0fs); capture %s, ML %s, check %s on average; "
            "up to %d of %d at once, %d waited for a slot, %d overran, %d actions dropped; "
            "%d before layer 1",
            self._mode or "concurrent",
            len(printing),
            len(self._recent),
            sum(1 for r in self._recent if r[1]),
            len(printing) * SUMMARY_SECONDS / interval,
            f"{periods[len(periods) // 2]:.1f}s" if periods else "-",
            interval,
            avg(2),
            avg(3),
            avg(4),
            minute["peak"],
            self.max_concurrent,
            minute["waits"],
            minute["overruns"],
            minute["dropped"],
            self._preparing_now,
        )

    def snapshot(self, allows: Callable[[int], bool]) -> dict:
        now = time.monotonic()
        printers = {}
        for printer_id, t in self._tracks.items():
            if not allows(printer_id):
                continue
            printers[printer_id] = {
                "printing": t.active,
                "in_flight": t.task is not None,
                "checks": t.checks,
                "ok": t.ok,
                "failed": t.failed,
                "consecutive_failures": t.failures,
                "overruns": t.overruns,
                "waits": t.waits,
                "dropped_actions": t.dropped_actions,
                "period": _avg_gap(t.starts),
                "ok_period": _avg_gap(t.oks),
                "last_ok_age": now - t.oks[-1] if t.oks else None,
                "next_in": t.due - now if t.due is not None and t.task is None else None,
                "lag": t.lag,
                "capture": t.capture,
                "ml": t.ml,
                "total": t.total,
                "capture_avg": t.capture_avg,
                "ml_avg": t.ml_avg,
                "total_avg": t.total_avg,
            }
        return {
            "mode": "concurrent" if self.enabled else "sequential",
            "max_concurrent": self.max_concurrent,
            "skip_preparation": self.skip_preparation,
            # Printing but before layer 1, so not checked (concurrent mode).
            "preparing": self._preparing_now if self.skip_preparation else 0,
            "in_flight": self.in_flight(),
            "interval": self._interval,
            "checks_last_minute": sum(1 for r in self._recent if r[0] >= now - SUMMARY_SECONDS),
            "ok_last_minute": sum(1 for r in self._recent if r[0] >= now - SUMMARY_SECONDS and r[1]),
            "printers": printers,
        }


# ---- module surface ----

_config = ObicoSchedulerSettings()
scheduler: ObicoScheduler | None = None


def install() -> ObicoScheduler:
    """Take over the scheduling of upstream's singleton. Idempotent. Called
    from register(), before the lifespan starts the service."""
    global scheduler
    from backend.app.services import obico_detection

    if not isinstance(obico_detection.httpx, _SharedTlsHttpx):
        obico_detection.httpx = _SharedTlsHttpx()
    service = obico_detection.obico_detection_service
    existing = service.__dict__.get("hyyz17200_scheduler")
    if isinstance(existing, ObicoScheduler):
        scheduler = existing
        return existing
    scheduler = ObicoScheduler(service, _config)
    scheduler.attach()
    return scheduler


def apply_settings(value: ObicoSchedulerSettings) -> None:
    global _config
    _config = value
    if scheduler is not None:
        scheduler.configure(value)
