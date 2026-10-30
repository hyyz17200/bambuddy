"""The fork's API routes, all under /hyyz17200."""

from fastapi import APIRouter

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission
from backend.app.models.user import User

router = APIRouter(prefix="/hyyz17200", tags=["hyyz17200"])


@router.get("/info")
async def get_fork_info(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Tells a running instance apart from a plain upstream build."""
    return {"fork": "hyyz17200"}
