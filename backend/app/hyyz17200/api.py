"""The fork's API routes, all under /hyyz17200."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import (
    RequireCameraStreamTokenIfAuthEnabled,
    RequirePermissionIfAuthEnabled,
    RequirePrinterPermissionIfAuthEnabled,
    StreamOpener,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.hyyz17200 import camera_frames, enhanced_settings, printer_intake
from backend.app.hyyz17200.hms_filter import load_hidden_codes, normalize_code
from backend.app.hyyz17200.models.hidden_fault import HiddenFault
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.schemas.not_null import IgnoresNullForRequiredColumns

router = APIRouter(prefix="/hyyz17200", tags=["hyyz17200"])


class HiddenFaultResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    note: str


class HiddenFaultCreate(BaseModel):
    code: str
    note: str = Field(default="", max_length=200)

    @field_validator("code")
    @classmethod
    def _normalize_code(cls, value: str) -> str:
        return normalize_code(value)


class IntakeStopResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    printer_id: int
    stopped_at: datetime | None
    stopped_by: str | None


class IntakeUpdate(IgnoresNullForRequiredColumns):
    # Upstream's guard (test_not_null_update_schemas) wants every PUT body on this
    # mixin. ``stopped`` adds or deletes a row rather than being a column, so the
    # mixin changes nothing: a null is still a 422.
    __orm_table__ = "hyyz17200_printer_intake_stop"

    stopped: bool


@router.get("/info")
async def get_fork_info(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Tells a running instance apart from a plain upstream build."""
    return {"fork": "hyyz17200"}


@router.get("/settings")
async def get_enhanced_settings(
    db: AsyncSession = Depends(get_db, scope="function"),
    # printers:read, like the hidden faults: the printer page and the camera
    # wall read these to draw, for everyone who can see them.
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
) -> dict[str, dict]:
    """Every section of the Enhanced Settings page, defaults filled in."""
    return await enhanced_settings.read_all(db)


@router.put("/settings/{section}")
async def put_enhanced_settings_section(
    section: str,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict:
    """Replace one section. Fields left out go back to their defaults."""
    model = enhanced_settings.SECTIONS.get(section)
    if model is None:
        raise HTTPException(status_code=404, detail="Unknown settings section")
    try:
        value = model.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False, include_context=False)) from exc
    await enhanced_settings.write_section(db, section, value)
    return value.model_dump()


# "/camera/snapshot" in the path is what lets a request with only a ?token= past
# the auth middleware (PUBLIC_API_PATTERNS matches by substring). The token
# dependency here does the checking, including which printers the token may open.
@router.get("/printers/{printer_id}/camera/snapshot-cached")
async def get_cached_camera_frame(
    printer_id: int,
    interval: int = Query(default=30, ge=2, le=300),
    if_none_match: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: StreamOpener = RequireCameraStreamTokenIfAuthEnabled,
):
    """The last good frame, at once: 204 until there is one, 304 if it has not changed.

    ``interval`` is how many seconds old a frame may get before another capture.
    """
    if await db.scalar(select(Printer.id).where(Printer.id == printer_id)) is None:
        camera_frames.forget(printer_id)
        raise HTTPException(status_code=404, detail="Printer not found")

    read = camera_frames.read_frame(printer_id, interval)
    headers = {"Cache-Control": "no-store", "X-Hyyz17200-Capture-Failures": str(read.failures)}
    if read.frame is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
    headers |= {"ETag": read.etag, "X-Hyyz17200-Frame-Age": str(read.age_seconds)}
    if if_none_match == read.etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=read.frame, media_type="image/jpeg", headers=headers)


@router.get("/hidden-faults", response_model=list[HiddenFaultResponse])
async def list_hidden_faults(
    db: AsyncSession = Depends(get_db, scope="function"),
    # printers:read, not settings:read: everyone who sees a printer card needs
    # this list to draw its badge the same way.
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
):
    result = await db.execute(select(HiddenFault).order_by(HiddenFault.code))
    return result.scalars().all()


@router.post("/hidden-faults", response_model=HiddenFaultResponse)
async def add_hidden_fault(
    body: HiddenFaultCreate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Hide a code. Adding one already listed just replaces its note."""
    fault = await db.get(HiddenFault, body.code)
    if fault is None:
        fault = HiddenFault(code=body.code, note=body.note)
        db.add(fault)
    else:
        fault.note = body.note
    await db.commit()
    await load_hidden_codes(db)
    return fault


@router.delete("/hidden-faults/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_hidden_fault(
    code: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    try:
        fault = await db.get(HiddenFault, normalize_code(code))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if fault is None:
        raise HTTPException(status_code=404, detail="This code is not hidden")
    await db.delete(fault)
    await db.commit()
    await load_hidden_codes(db)


@router.get("/printers/intake-stops", response_model=list[IntakeStopResponse])
async def list_intake_stops(
    db: AsyncSession = Depends(get_db, scope="function"),
    # Everyone who sees a printer card needs this to draw it.
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
):
    """Printers that are not taking queue jobs."""
    return await printer_intake.list_stops(db)


@router.put("/printers/{printer_id}/intake", response_model=IntakeUpdate)
async def put_printer_intake(
    printer_id: int,
    body: IntakeUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    # The permission maintenance mode needs, checked against the caller's
    # printer scope like upstream's own printer edits.
    user: User | None = RequirePrinterPermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
):
    """Stop or resume sending queue jobs to a printer. A running print is not touched."""
    if await db.scalar(select(Printer.id).where(Printer.id == printer_id)) is None:
        raise HTTPException(status_code=404, detail="Printer not found")
    await printer_intake.set_stopped(db, printer_id, body.stopped, user.username if user else None)
    return body
