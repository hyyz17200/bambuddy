"""Slice many library 3MFs as designed, one after another.

Upstream's "Use the file's built-in settings" slices a 3MF with its own
``project_settings.config``, but only one file at a time, only when the picked
printer preset has the same name as the file's, and still with a printer,
process and filament preset picked: they are resolved before the slice even
though nothing uses them. A 3MF saved with a custom printer preset never gets
the option.

Each file here goes through upstream's own ``slice_library_file`` route
function, so visibility, file checks, the output name, the destination folder
and the new library row are upstream's. Only the slicing step is swapped:
``install()`` wraps ``library._run_slicer_with_fallback`` and, while a batch
file is being sliced (``_ACTIVE``), slices without profiles instead of
resolving presets. The upstream slice job is created inside that context and
``asyncio.create_task`` copies it, so the job sees the flag and nothing else
does.

Files run one at a time across all batches: the sidecar is one slicer, and a
farm's worth of slices at once would only make each of them slower. Batches are
kept in memory. A restart drops them, and the files already sliced stay.
"""

from __future__ import annotations

import asyncio
import io
import logging
import zipfile
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.core.config import settings as app_settings
from backend.app.core.permissions import Permission
from backend.app.core.tasks import spawn_background_task
from backend.app.models.library import LibraryFile
from backend.app.schemas.slicer import PresetRef, SliceRequest

logger = logging.getLogger(__name__)

# Set while a batch file is handed to upstream's slice route.
_ACTIVE: ContextVar[bool] = ContextVar("hyyz17200_slice_as_designed", default=False)

# Upstream requires a preset in each slot. These are never resolved: the wrapped
# slicer step returns before upstream would read them.
_UNUSED_PRESET = PresetRef(source="standard", id="hyyz17200-slice-as-designed")

MAX_FILES = 500
POLL_SECONDS = 1.0
# How long a finished batch stays readable, so a browser that was closed while it
# ran still gets the summary.
KEEP_FINISHED = timedelta(hours=12)
KEEP_BATCHES = 20

_PROJECT_SETTINGS = "Metadata/project_settings.config"
_MODEL_SETTINGS = "Metadata/model_settings.config"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- The swapped slicing step -------------------------------------------------


def install() -> None:
    """Wrap upstream's slicing step. Safe to call more than once."""
    from backend.app.api.routes import library

    upstream = library._run_slicer_with_fallback
    if getattr(upstream, "hyyz17200", False):
        return

    async def run_slicer(db, **kwargs):
        request: SliceRequest = kwargs["request"]
        if _ACTIVE.get() and request.use_embedded_settings:
            result = await slice_embedded(
                db,
                model_bytes=kwargs["model_bytes"],
                model_filename=kwargs["model_filename"],
                plate=request.plate,
                job_id=kwargs.get("job_id"),
            )
            return result, True
        return await upstream(db, **kwargs)

    run_slicer.hyyz17200 = True  # type: ignore[attr-defined]
    run_slicer.upstream = upstream  # type: ignore[attr-defined]
    library._run_slicer_with_fallback = run_slicer


async def slicer_api_url(db: AsyncSession) -> str:
    """The sidecar upstream would use: the same settings, in the same order."""
    from backend.app.api.routes.settings import get_setting

    preferred = (await get_setting(db, "preferred_slicer")) or "bambu_studio"
    if preferred == "orcaslicer":
        configured = await get_setting(db, "orcaslicer_api_url")
        return (configured or app_settings.slicer_api_url).strip()
    if preferred == "bambu_studio":
        configured = await get_setting(db, "bambu_studio_api_url")
        return (configured or app_settings.bambu_studio_api_url).strip()
    raise HTTPException(
        status_code=400,
        detail=f"Unknown preferred_slicer setting: '{preferred}'. Expected 'orcaslicer' or 'bambu_studio'.",
    )


async def slice_embedded(
    db: AsyncSession,
    *,
    model_bytes: bytes,
    model_filename: str,
    plate: int | None,
    job_id: int | None,
):
    """Slice a 3MF with only its own settings: no profiles, no arrange, no orient.
    Errors become the same HTTP answers upstream's slicing step gives."""
    from backend.app.api.routes.library import _slicer_rejection_message
    from backend.app.services.slice_dispatch import slice_dispatch
    from backend.app.services.slicer_api import (
        SlicerApiServerError,
        SlicerApiService,
        SlicerApiUnavailableError,
        SlicerInputError,
        SlicerTimeoutError,
        get_stall_timeout_seconds,
    )
    from backend.app.utils.threemf_tools import sanitize_project_settings_sentinels

    api_url = await slicer_api_url(db)
    # Same reason as upstream (#1201, #3030): the CLI's range check refuses the
    # inherit/unset sentinels Bambu Studio leaves in the file.
    model_bytes = sanitize_project_settings_sentinels(model_bytes)

    request_id: str | None = None
    on_progress = None
    if job_id is not None:
        from uuid import uuid4

        request_id = str(uuid4())

        def on_progress(snapshot: dict) -> None:
            slice_dispatch.set_progress(job_id, snapshot)

    service = SlicerApiService(api_url, timeout_seconds=await get_stall_timeout_seconds(db))
    try:
        return await service.slice_without_profiles(
            model_bytes=model_bytes,
            model_filename=model_filename,
            plate=plate,
            export_3mf=True,
            arrange=False,
            orient=False,
            request_id=request_id,
            on_progress=on_progress,
        )
    except SlicerInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SlicerTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except SlicerApiServerError as exc:
        rejection = _slicer_rejection_message(str(exc))
        if rejection:
            raise HTTPException(status_code=400, detail=rejection) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except SlicerApiUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        await service.close()


# --- Reading the source ---------------------------------------------------------


def plate_ids(zf: zipfile.ZipFile) -> list[int]:
    """The plate numbers a project 3MF declares, from ``model_settings.config``."""
    if _MODEL_SETTINGS not in zf.namelist():
        return []
    try:
        root = ET.fromstring(zf.read(_MODEL_SETTINGS).decode())
    except (ET.ParseError, UnicodeDecodeError, KeyError):
        return []
    ids: list[int] = []
    for plate in root.iter("plate"):
        for meta in plate.findall("metadata"):
            if meta.get("key") == "plater_id":
                try:
                    ids.append(int(meta.get("value") or ""))
                except ValueError:
                    pass
    return ids


def plate_to_slice(ids: list[int]) -> int | None:
    """One plate: that plate. Several: 0, the sidecar's "every plate" (one
    ``.gcode.3mf`` holding a G-code per plate). None: let the sidecar default."""
    if len(ids) == 1:
        return ids[0]
    if len(ids) > 1:
        return 0
    return None


@dataclass(frozen=True)
class SourceCheck:
    reason: str | None  # why it is skipped, or None
    plate: int | None = None
    plate_count: int = 0


def check_source(path: Path) -> SourceCheck:
    """Whether a library file can be sliced as designed."""
    try:
        data = path.read_bytes()
    except OSError:
        return SourceCheck("missing")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            if any(n.startswith("Metadata/plate_") and n.endswith(".gcode") for n in names):
                return SourceCheck("already_sliced")
            if _PROJECT_SETTINGS not in names:
                return SourceCheck("no_settings")
            ids = plate_ids(zf)
    except (zipfile.BadZipFile, OSError):
        return SourceCheck("unreadable")
    return SourceCheck(None, plate_to_slice(ids), len(ids))


# --- Batches -----------------------------------------------------------------------


@dataclass
class Caller:
    """What upstream's slice route takes from its dependencies."""

    current_user: Any
    api_key_cloud_owner: Any
    actor: Any

    @property
    def owner_id(self) -> int | None:
        return getattr(self.actor, "id", None)


@dataclass
class Item:
    file_id: int
    name: str
    status: str = "pending"  # pending, running, done, failed, skipped, cancelled
    reason: str | None = None
    detail: str | None = None
    plate: int | None = None
    plate_count: int = 0
    job_id: int | None = None
    output_file_id: int | None = None
    output_name: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


@dataclass
class Batch:
    id: int
    caller: Caller
    items: list[Item]
    created_at: datetime = field(default_factory=utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    cancelled: bool = False

    @property
    def status(self) -> str:
        if self.finished_at is not None:
            return "cancelled" if self.cancelled else "finished"
        return "running" if self.started_at is not None else "queued"


_batches: dict[int, Batch] = {}
_queue: deque[Batch] = deque()
_next_id = 1


def _prune() -> None:
    now = utcnow()
    finished = sorted((b for b in _batches.values() if b.finished_at is not None), key=lambda b: b.finished_at or now)
    for b in finished:
        if now - (b.finished_at or now) > KEEP_FINISHED or len(_batches) > KEEP_BATCHES:
            _batches.pop(b.id, None)


def _can_see(batch: Batch, actor: Any) -> bool:
    if actor is None:  # auth off
        return True
    if actor.has_permission(Permission.LIBRARY_READ_ALL.value):
        return True
    return batch.caller.owner_id is not None and batch.caller.owner_id == getattr(actor, "id", None)


async def create_batch(db: AsyncSession, file_ids: list[int], caller: Caller) -> Batch:
    """Check every file now, so the ones that can't be sliced show up straight
    away, and queue the rest. Upstream checks them again when each one runs."""
    from backend.app.api.routes.library import _ensure_library_file_visible

    global _next_id
    actor = caller.actor
    can_read_all = actor is None or actor.has_permission(Permission.LIBRARY_READ_ALL.value)

    unique_ids = list(dict.fromkeys(file_ids))
    rows = (
        (await db.execute(LibraryFile.active().where(LibraryFile.id.in_(unique_ids)))).scalars().all()
        if unique_ids
        else []
    )
    by_id = {row.id: row for row in rows}

    items: list[Item] = []
    for file_id in unique_ids:
        row = by_id.get(file_id)
        try:
            row = _ensure_library_file_visible(row, actor, can_read_all)
        except HTTPException:
            items.append(Item(file_id, f"#{file_id}", status="skipped", reason="not_found"))
            continue
        name = row.filename or f"#{file_id}"
        lower = name.lower()
        if not lower.endswith(".3mf") or lower.endswith(".gcode.3mf"):
            items.append(Item(file_id, name, status="skipped", reason="not_3mf"))
            continue
        check = await asyncio.to_thread(check_source, Path(app_settings.base_dir) / row.file_path)
        if check.reason is not None:
            items.append(Item(file_id, name, status="skipped", reason=check.reason))
            continue
        items.append(Item(file_id, name, plate=check.plate, plate_count=check.plate_count))

    batch = Batch(id=_next_id, caller=caller, items=items)
    _next_id += 1
    _batches[batch.id] = batch
    if any(item.status == "pending" for item in items):
        _queue.append(batch)
        runner.ensure_running()
    else:
        batch.finished_at = utcnow()
    _prune()
    return batch


def cancel_batch(batch_id: int, actor: Any) -> Batch | None:
    """Stop after the file being sliced now; the rest are marked cancelled."""
    batch = _batches.get(batch_id)
    if batch is None or not _can_see(batch, actor):
        return None
    if batch.finished_at is not None:
        return batch
    batch.cancelled = True
    now = utcnow()
    for item in batch.items:
        if item.status == "pending":
            item.status = "cancelled"
            item.finished_at = now
    if batch.started_at is None:
        # Never reached the worker.
        if batch in _queue:
            _queue.remove(batch)
        batch.finished_at = now
    return batch


def list_batches(actor: Any) -> list[Batch]:
    _prune()
    return sorted((b for b in _batches.values() if _can_see(b, actor)), key=lambda b: b.id)


def serialize(batch: Batch) -> dict[str, Any]:
    from backend.app.services.slice_dispatch import slice_dispatch

    items = []
    for item in batch.items:
        progress = None
        if item.status == "running" and item.job_id is not None:
            job = slice_dispatch.get(item.job_id)
            if job is not None and job.progress:
                progress = {
                    "stage": job.progress.get("stage"),
                    "total_percent": job.progress.get("total_percent"),
                }
        items.append(
            {
                "file_id": item.file_id,
                "name": item.name,
                "status": item.status,
                "reason": item.reason,
                "detail": item.detail,
                "plate_count": item.plate_count,
                "output_file_id": item.output_file_id,
                "output_name": item.output_name,
                "progress": progress,
            }
        )
    return {
        "id": batch.id,
        "status": batch.status,
        "created_at": batch.created_at.isoformat(),
        "finished_at": batch.finished_at.isoformat() if batch.finished_at else None,
        "items": items,
    }


async def _slice_one(batch: Batch, item: Item) -> None:
    from backend.app.api.routes import library
    from backend.app.services.slice_dispatch import slice_dispatch

    request = SliceRequest(
        printer_preset=_UNUSED_PRESET,
        process_preset=_UNUSED_PRESET,
        filament_presets=[_UNUSED_PRESET],
        plate=item.plate,
        use_embedded_settings=True,
    )
    token = _ACTIVE.set(True)
    try:
        async with database.async_session() as db:
            answer = await library.slice_library_file(
                file_id=item.file_id,
                request=request,
                db=db,
                current_user=batch.caller.current_user,
                api_key_cloud_owner=batch.caller.api_key_cloud_owner,
                actor=batch.caller.actor,
            )
    except HTTPException as exc:
        item.status = "failed"
        item.detail = str(exc.detail)
        return
    finally:
        _ACTIVE.reset(token)

    item.job_id = answer["job_id"]
    while True:
        job = slice_dispatch.get(item.job_id)
        if job is None:
            item.status = "failed"
            item.detail = "The slice job was lost"
            return
        if job.status == "completed":
            result = job.result or {}
            item.status = "done"
            item.output_file_id = result.get("library_file_id")
            item.output_name = result.get("name")
            return
        if job.status == "failed":
            item.status = "failed"
            item.detail = job.error_detail or "Slice failed"
            return
        await asyncio.sleep(POLL_SECONDS)


async def _run_batch(batch: Batch) -> None:
    batch.started_at = batch.started_at or utcnow()
    for item in batch.items:
        if batch.cancelled:
            break
        if item.status != "pending":
            continue
        item.status = "running"
        item.started_at = utcnow()
        try:
            await _slice_one(batch, item)
        except asyncio.CancelledError:
            item.status = "failed"
            item.detail = "Bambuddy stopped"
            raise
        except Exception as exc:
            logger.exception("hyyz17200 slice as designed: %s failed", item.name)
            item.status = "failed"
            item.detail = f"Unexpected error: {exc}"
        item.finished_at = utcnow()
        logger.info("hyyz17200 slice as designed: %s -> %s %s", item.name, item.status, item.detail or "")
    now = utcnow()
    for item in batch.items:
        if item.status == "pending":
            item.status = "cancelled"
            item.finished_at = now
    batch.finished_at = now


class _Runner:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def ensure_running(self) -> None:
        if self._task is None or self._task.done():
            self._task = spawn_background_task(self._run(), name="hyyz17200-slice-as-designed")

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _run(self) -> None:
        while _queue:
            batch = _queue[0]
            try:
                await _run_batch(batch)
            finally:
                if _queue and _queue[0] is batch:
                    _queue.popleft()


runner = _Runner()


def reset_for_tests() -> None:
    global _next_id
    runner.stop()
    _batches.clear()
    _queue.clear()
    _next_id = 1


__all__ = [
    "Caller",
    "cancel_batch",
    "check_source",
    "create_batch",
    "install",
    "list_batches",
    "plate_ids",
    "plate_to_slice",
    "runner",
    "serialize",
]
