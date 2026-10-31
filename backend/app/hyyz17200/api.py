"""The fork's API routes, all under /hyyz17200."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.hyyz17200.hms_filter import load_hidden_codes, normalize_code
from backend.app.hyyz17200.models.hidden_fault import HiddenFault
from backend.app.models.user import User

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


@router.get("/info")
async def get_fork_info(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Tells a running instance apart from a plain upstream build."""
    return {"fork": "hyyz17200"}


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
