"""The hyyz17200 fork's code (see .claude/rules/hyyz17200-fork.md)."""

from fastapi import FastAPI

from backend.app.core.config import settings
from backend.app.hyyz17200.api import router


def register(app: FastAPI) -> None:
    """Add the fork's routes. Called from main.py with the upstream routers."""
    app.include_router(router, prefix=settings.api_prefix)
