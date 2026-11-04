"""Batch calibration: printers calibrated one at a time.

Vibration compensation shakes the printer on purpose, and printers sharing a
shelf shake each other, so a batch never runs two at once. The rule that keeps
it so does not depend on the printer model: **the next printer starts only
after the last one is idle again**, plus a short settle. Whatever the printer
does after the command, recognised or not, the batch waits it out.

Per printer:

1. ``waiting``: its turn comes once it is connected, idle, not in maintenance,
   not holding a plate-clear confirmation (when the global switch is on), and
   no queue job is being sent to it. A printer that is not ready is passed over
   and tried again later, so one printer cannot hold up the rest.
2. ``starting``: upstream's ``start_calibration`` was sent. The printer has to
   leave idle within ``START_TIMEOUT_SECONDS``; one that stays idle failed to
   start (``not_started``).
3. ``running``: until it is idle again. ``FINISH`` with the job seen as the
   calibration (``auto_cali_for_user``, as Bambu Studio checks) is a success;
   ``FAILED`` is ``printer_failed``; back to ``IDLE`` is ``no_result``; a job
   never seen as the calibration is ``unrecognized``. An offline or paused
   printer is waited for, not skipped: it may still be moving.

Only bed levelling (bit 1) and vibration compensation (bit 2) are sent as they
are. Motor noise cancellation (bit 3) is sent only to a printer that reports it
(calibration_support.py). Nothing else is ever sent.

Starting a batch stops every printer in it taking jobs (printer_intake.py), so
the queue sends them nothing meanwhile. With ``resume_intake`` each printer
takes jobs again as soon as its own calibration succeeds, unless it was not
taking jobs before the batch. Resuming a waiting printer by hand takes it out
of the batch (``intake_resumed``). Failures and cancellations leave it stopped.

A completed batch calibration does not raise upstream's plate-clear check:
see :func:`skips_plate_clear`, called through plate_swap's hook in main.py.

The batch is kept in the database and picked up again after a restart.
Upstream's kill switch for unauthorised prints (billing) cannot tell an A1 or
P1 calibration from a user's print, so while it is on no batch starts and a
running batch does not start its next printer.
"""

import asyncio
import logging
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.hyyz17200 import calibration_support, printer_intake
from backend.app.hyyz17200.models.calibration import CalibrationBatch, CalibrationItem
from backend.app.hyyz17200.models.printer_intake import PrinterIntakeStop
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.bambu_mqtt import get_stage_name
from backend.app.services.finance_budget import is_printer_kill_switch_enabled
from backend.app.services.printer_manager import printer_manager
from backend.app.utils.local_time import utcnow_naive

logger = logging.getLogger(__name__)

BED_LEVELING = 1 << 1
VIBRATION = 1 << 2
MOTOR_NOISE = 1 << 3

POLL_SECONDS = 5
# The printer must leave idle this soon after the command.
START_TIMEOUT_SECONDS = 180
# After one printer is idle again, before the next starts: it may still be
# parking.
SETTLE_SECONDS = 45
# A completion arriving this long after the batch marked the printer done
# still counts as the batch's (the two are not ordered).
PLATE_CLEAR_GRACE_SECONDS = 120

# Bambu Studio's test: the calibration job's file is auto_cali_for_user.gcode
# on some printers and auto_cali_for_user_param on A1, A1 mini and P1.
CALIBRATION_JOB = "auto_cali_for_user"
ACTIVE_STATES = frozenset({"PREPARE", "RUNNING", "PAUSE", "SLICING"})
IDLE_STATES = frozenset({"IDLE", "FINISH", "FAILED"})
TRACKED = ("starting", "running")
OPEN = ("waiting", *TRACKED)

# Serialises the runner's passes with creating and cancelling a batch.
_lock = asyncio.Lock()
# printer_id -> the last observation logged, so the log shows changes only.
_observed: dict[int, tuple] = {}


class BatchError(Exception):
    """A batch that cannot be started. ``code`` is for the page to translate."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def is_calibration_job(state: object) -> bool:
    names = (getattr(state, "gcode_file", None), getattr(state, "subtask_name", None))
    return any(CALIBRATION_JOB in str(name).lower() for name in names if name)


async def _bool_setting(db: AsyncSession, key: str) -> bool:
    value = await db.scalar(select(Settings.value).where(Settings.key == key))
    return (value or "").strip().lower() == "true"


def _queue_sending_to(printer_id: int) -> bool:
    """A queue job is on its way to the printer: uploading, or sent and not yet
    showing. Reads the scheduler's own bookkeeping (test_hyyz17200_calibration
    fails if upstream renames it)."""
    from backend.app.services.print_scheduler import scheduler

    inflight = getattr(scheduler, "_inflight", None) or {}
    if any(pid == printer_id for (_task, pid) in inflight.values()):
        return True
    in_hold = getattr(scheduler, "_printer_in_dispatch_hold", None)
    return bool(in_hold and in_hold(printer_id))


def _blocker(printer: Printer | None, require_plate_clear: bool) -> str | None:
    """Why the printer cannot start its calibration now, or None."""
    from backend.app.services.firmware_update import upload_in_progress

    if printer is None:
        return "deleted"
    if not printer.is_active:
        return "maintenance"
    state = printer_manager.get_status(printer.id)
    if not printer_manager.is_connected(printer.id) or state is None:
        return "offline"
    if require_plate_clear and printer_manager.is_awaiting_plate_clear(printer.id):
        return "plate_clear"
    if (state.state or "").upper() not in IDLE_STATES or upload_in_progress(printer.id):
        return "busy"
    if _queue_sending_to(printer.id):
        return "busy"
    return None


async def _blockers(db: AsyncSession, printer_ids: Iterable[int]) -> dict[int, str | None]:
    ids = list(printer_ids)
    if not ids:
        return {}
    require_plate_clear = await _bool_setting(db, "require_plate_clear")
    rows = (await db.execute(select(Printer).where(Printer.id.in_(ids)))).scalars().all()
    printers = {p.id: p for p in rows}
    return {pid: _blocker(printers.get(pid), require_plate_clear) for pid in ids}


async def _latest_batch(db: AsyncSession) -> CalibrationBatch | None:
    return await db.scalar(select(CalibrationBatch).order_by(CalibrationBatch.id.desc()).limit(1))


async def _running_batch(db: AsyncSession) -> CalibrationBatch | None:
    batch = await _latest_batch(db)
    return batch if batch is not None and batch.status == "running" else None


async def _items(db: AsyncSession, batch_id: int) -> list[CalibrationItem]:
    rows = await db.execute(
        select(CalibrationItem)
        .join(Printer, Printer.id == CalibrationItem.printer_id)
        .where(CalibrationItem.batch_id == batch_id)
        .order_by(CalibrationItem.position)
    )
    return list(rows.scalars().all())


def _finish(item: CalibrationItem, status: str, detail: str | None, now: datetime) -> None:
    item.status = status
    item.detail = detail
    item.finished_at = now
    logger.info(
        "hyyz17200 calibration: printer %s %s%s (sent option %s, stages %s)",
        item.printer_id,
        status,
        f" ({detail})" if detail else "",
        item.option,
        item.stages or "none",
    )


# ---------------------------------------------------------------- the page


async def preview(db: AsyncSession, printer_ids: list[int]) -> dict:
    """What a batch of these printers would do, for the dialog before starting."""
    ids = list(dict.fromkeys(printer_ids))
    support = await calibration_support.probe(ids)
    blockers = await _blockers(db, ids)
    rows = (await db.execute(select(Printer).where(Printer.id.in_(ids)))).scalars().all()
    printers = {p.id: p for p in rows}
    return {
        "kill_switch": await is_printer_kill_switch_enabled(db),
        "batch_running": await _running_batch(db) is not None,
        "printers": [
            {
                "printer_id": pid,
                "name": printers[pid].name,
                "model": printers[pid].model,
                "motor_noise": support.get(pid),
                "blocker": blockers.get(pid),
            }
            for pid in ids
            if pid in printers
        ],
    }


async def read_latest(db: AsyncSession, allows: Callable[[int], bool]) -> dict | None:
    """The current batch, or the last one, with each printer the caller may see."""
    batch = await _latest_batch(db)
    if batch is None:
        return None
    items = [item for item in await _items(db, batch.id) if allows(item.printer_id)]
    names = dict(
        (await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_([i.printer_id for i in items])))).all()
    )
    running = batch.status == "running"
    kill_switch = running and await is_printer_kill_switch_enabled(db)
    blockers = await _blockers(db, [i.printer_id for i in items if i.status == "waiting"]) if running else {}

    def stage(item: CalibrationItem) -> str | None:
        if item.status != "running":
            return None
        state = printer_manager.get_status(item.printer_id)
        stg_cur = getattr(state, "stg_cur", -1) if state is not None else -1
        return get_stage_name(stg_cur) if isinstance(stg_cur, int) and stg_cur >= 0 else None

    return {
        "id": batch.id,
        "status": batch.status,
        "created_at": batch.created_at,
        "created_by": batch.created_by,
        "finished_at": batch.finished_at,
        "bed_leveling": batch.bed_leveling,
        "vibration": batch.vibration,
        "motor_noise": batch.motor_noise,
        "resume_intake": batch.resume_intake,
        "items": [
            {
                "printer_id": item.printer_id,
                "name": names.get(item.printer_id, ""),
                "status": item.status,
                "detail": item.detail,
                "blocker": ("kill_switch" if kill_switch else blockers.get(item.printer_id))
                if item.status == "waiting"
                else None,
                "option": item.option,
                "motor_noise_skipped": item.motor_noise_skipped,
                "stage": stage(item),
                "started_at": item.started_at,
                "finished_at": item.finished_at,
            }
            for item in items
        ],
    }


async def create_batch(
    db: AsyncSession,
    printer_ids: list[int],
    *,
    bed_leveling: bool,
    vibration: bool,
    motor_noise: bool,
    resume_intake: bool,
    by: str | None,
) -> CalibrationBatch:
    """Start a batch, in the order given. The caller checked the printers exist
    and are the caller's to use."""
    ids = list(dict.fromkeys(printer_ids))
    if not ids:
        raise BatchError("no_printers")
    if not (bed_leveling or vibration or motor_noise):
        raise BatchError("nothing_selected")
    async with _lock:
        if await _running_batch(db) is not None:
            raise BatchError("batch_running")
        if await is_printer_kill_switch_enabled(db):
            raise BatchError("kill_switch")
        # Only the latest batch is kept. Items first: SQLite does not cascade.
        await db.execute(delete(CalibrationItem))
        await db.execute(delete(CalibrationBatch))
        stopped = await printer_intake.stopped_printer_ids(db)
        batch = CalibrationBatch(
            created_by=by,
            bed_leveling=bed_leveling,
            vibration=vibration,
            motor_noise=motor_noise,
            resume_intake=resume_intake,
        )
        db.add(batch)
        await db.flush()
        for position, printer_id in enumerate(ids):
            db.add(
                CalibrationItem(
                    batch_id=batch.id,
                    printer_id=printer_id,
                    position=position,
                    intake_was_stopped=printer_id in stopped,
                )
            )
            # A row left by a deleted printer whose id was reused is not in
            # ``stopped`` (it joins printers) but would still collide.
            if printer_id not in stopped and await db.get(PrinterIntakeStop, printer_id) is None:
                db.add(PrinterIntakeStop(printer_id=printer_id, stopped_by=by))
        await db.commit()
    for printer_id in ids:
        calibration_support.watch(printer_id)
    logger.info(
        "hyyz17200 calibration: batch %s started by %s for printers %s (bed %s, vibration %s, motor noise %s)",
        batch.id,
        by,
        ids,
        bed_leveling,
        vibration,
        motor_noise,
    )
    runner.ensure_running()
    return batch


async def cancel_batch(db: AsyncSession) -> bool:
    """Stop the batch. A printer calibrating now carries on; it is no longer
    followed. Every printer stays as it is about taking jobs."""
    async with _lock:
        batch = await _running_batch(db)
        if batch is None:
            return False
        now = utcnow_naive()
        for item in await _items(db, batch.id):
            if item.status in OPEN:
                _finish(item, "cancelled", "batch_cancelled", now)
        batch.status = "cancelled"
        batch.finished_at = now
        await db.commit()
        logger.info("hyyz17200 calibration: batch %s cancelled", batch.id)
        return True


# ---------------------------------------------------------------- the run


def _log_observation(item: CalibrationItem, state: object, connected: bool) -> None:
    """Every change of what the printer reports, while it is followed."""
    observation = (
        connected,
        getattr(state, "state", None),
        getattr(state, "gcode_file", None),
        getattr(state, "subtask_name", None),
        getattr(state, "stg_cur", None),
        calibration_support.mc_print_stage(item.printer_id),
    )
    if _observed.get(item.printer_id) == observation:
        return
    _observed[item.printer_id] = observation
    home_flag = calibration_support.home_flag(item.printer_id)
    logger.info(
        "hyyz17200 calibration: printer %s %s: connected=%s gcode_state=%s gcode_file=%s subtask_name=%s "
        "stg_cur=%s mc_print_stage=%s home_flag=%s",
        item.printer_id,
        item.status,
        *observation,
        f"0x{home_flag:08X}" if home_flag is not None else None,
    )


def _note_stage(item: CalibrationItem, stage: object) -> None:
    if not isinstance(stage, int) or stage < 0:
        return
    stages = item.stages.split(",") if item.stages else []
    if stages and stages[-1] == str(stage):
        return
    joined = ",".join([*stages, str(stage)])
    if len(joined) <= 400:
        item.stages = joined


async def _follow(db: AsyncSession, batch: CalibrationBatch, item: CalibrationItem, now: datetime) -> None:
    """Move the printer being calibrated on, from what it reports now."""
    state = printer_manager.get_status(item.printer_id)
    connected = printer_manager.is_connected(item.printer_id)
    _log_observation(item, state, connected)
    if not connected or state is None:
        # It may well still be moving: wait for it to come back.
        return
    gcode_state = (state.state or "").upper()
    active = gcode_state in ACTIVE_STATES
    if active and is_calibration_job(state):
        item.recognized = True

    if item.status == "starting":
        if active:
            item.status = "running"
            item.running_at = now
            logger.info("hyyz17200 calibration: printer %s left idle (%s)", item.printer_id, gcode_state)
        elif item.started_at is None or now - item.started_at >= timedelta(seconds=START_TIMEOUT_SECONDS):
            _finish(item, "failed", "not_started", now)
        return

    if active or gcode_state not in IDLE_STATES:
        _note_stage(item, getattr(state, "stg_cur", None))
        return

    if not item.recognized:
        _finish(item, "failed", "unrecognized", now)
    elif gcode_state == "FINISH":
        _finish(item, "succeeded", None, now)
        if batch.resume_intake and not item.intake_was_stopped:
            await printer_intake.set_stopped(db, item.printer_id, False, None)
            logger.info("hyyz17200 calibration: printer %s takes jobs again", item.printer_id)
    elif gcode_state == "FAILED":
        _finish(item, "failed", "printer_failed", now)
    else:
        _finish(item, "failed", "no_result", now)


async def _start(db: AsyncSession, batch: CalibrationBatch, item: CalibrationItem) -> None:
    supported = None
    if batch.motor_noise:
        supported = (await calibration_support.probe([item.printer_id])).get(item.printer_id)
    motor_noise = batch.motor_noise and supported is True
    option = (
        (BED_LEVELING if batch.bed_leveling else 0)
        | (VIBRATION if batch.vibration else 0)
        | (MOTOR_NOISE if motor_noise else 0)
    )
    item.motor_noise_skipped = batch.motor_noise and not motor_noise
    if option == 0:
        _finish(item, "skipped", "motor_noise_unsupported", utcnow_naive())
        return
    client = printer_manager.get_client(item.printer_id)
    sent = client is not None and client.start_calibration(
        bed_leveling=bool(option & BED_LEVELING),
        vibration=bool(option & VIBRATION),
        motor_noise=motor_noise,
    )
    if not sent:
        # Lost the connection in between: it waits for the next pass.
        logger.info("hyyz17200 calibration: printer %s could not be sent the command", item.printer_id)
        return
    item.option = option
    item.status = "starting"
    item.started_at = utcnow_naive()
    logger.info(
        "hyyz17200 calibration: printer %s sent option %s (motor noise %s)",
        item.printer_id,
        option,
        "skipped, not reported" if item.motor_noise_skipped else ("on" if motor_noise else "off"),
    )


def _settling(items: list[CalibrationItem], now: datetime) -> bool:
    ends = [i.finished_at for i in items if i.option is not None and i.finished_at is not None]
    return bool(ends) and now - max(ends) < timedelta(seconds=SETTLE_SECONDS)


async def tick(db: AsyncSession) -> bool:
    """One pass. False once there is no running batch left to follow."""
    async with _lock:
        batch = await _running_batch(db)
        if batch is None:
            return False
        items = await _items(db, batch.id)
        now = utcnow_naive()

        current = next((item for item in items if item.status in TRACKED), None)
        if current is not None:
            await _follow(db, batch, current, now)
            await db.commit()
            if current.status in TRACKED:
                return True

        if _settling(items, now):
            return True

        waiting = [item for item in items if item.status == "waiting"]
        if not waiting:
            batch.status = "finished"
            batch.finished_at = now
            await db.commit()
            for item in items:
                calibration_support.forget(item.printer_id)
                _observed.pop(item.printer_id, None)
            logger.info("hyyz17200 calibration: batch %s finished", batch.id)
            return False

        if await is_printer_kill_switch_enabled(db):
            return True
        stopped = await printer_intake.stopped_printer_ids(db)
        blockers = await _blockers(db, [item.printer_id for item in waiting])
        for item in waiting:
            if item.printer_id not in stopped:
                _finish(item, "cancelled", "intake_resumed", now)
                continue
            if blockers.get(item.printer_id) is None:
                await _start(db, batch, item)
                # Skipped, or the command did not go out: nothing is moving,
                # so the next one may go.
                if item.status == "starting":
                    break
        await db.commit()
        return True


async def skips_plate_clear(db: AsyncSession, printer_id: int, data: dict) -> bool:
    """This completion is a batch calibration's, so nothing was left on the bed.

    Called by plate_swap.plate_swapped_away from main.py's plate-clear hook.
    The batch may have marked the printer done just before the completion
    arrives, or not yet, so both count.
    """
    if data.get("status") != "completed":
        return False
    names = [str(n).lower() for n in (data.get("filename"), data.get("subtask_name")) if n]
    if names and not any(CALIBRATION_JOB in name for name in names):
        return False
    item = await db.scalar(
        select(CalibrationItem)
        .where(CalibrationItem.printer_id == printer_id, CalibrationItem.status.in_(("running", "succeeded")))
        .order_by(CalibrationItem.id.desc())
        .limit(1)
    )
    if item is None:
        return False
    if item.status == "succeeded" and (
        item.finished_at is None or utcnow_naive() - item.finished_at > timedelta(seconds=PLATE_CLEAR_GRACE_SECONDS)
    ):
        return False
    return item.recognized or bool(names)


class _Runner:
    """The background loop. Runs while a batch is running, and is started again
    by a new batch or at startup (register() in __init__.py)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def ensure_running(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-calibration")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                async with database.async_session() as db:
                    more = await tick(db)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("hyyz17200 calibration: pass failed")
                more = True
            if not more:
                return
            await asyncio.sleep(POLL_SECONDS)


runner = _Runner()


async def resume_at_startup() -> None:
    """Pick a running batch up again after a restart."""
    try:
        async with database.async_session() as db:
            batch = await _running_batch(db)
            if batch is None:
                return
            for item in await _items(db, batch.id):
                if item.status in OPEN:
                    calibration_support.watch(item.printer_id)
    except Exception:
        logger.exception("hyyz17200 calibration: could not check for a batch to resume")
        return
    logger.info("hyyz17200 calibration: resuming batch %s", batch.id)
    runner.ensure_running()
