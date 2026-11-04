"""The hyyz17200 fork's code (see .claude/rules/hyyz17200-fork.md)."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.app.core.config import settings
from backend.app.hyyz17200.api import router


def register(app: FastAPI) -> None:
    """Add the fork's routes and background work. Called from main.py with the
    upstream routers, after the app (and its lifespan) is built."""
    app.include_router(router, prefix=settings.api_prefix)
    _wrap_lifespan(app)


def _wrap_lifespan(app: FastAPI) -> None:
    """Run the fork's startup and shutdown inside upstream's lifespan, rather
    than adding lines to it: after upstream's startup, before its shutdown."""
    upstream = app.router.lifespan_context
    if getattr(upstream, "hyyz17200", False):
        return

    @asynccontextmanager
    async def lifespan(app_: FastAPI):
        from backend.app.hyyz17200 import calibration_batch

        async with upstream(app_) as state:
            await calibration_batch.resume_at_startup()
            try:
                yield state
            finally:
                calibration_batch.runner.stop()

    lifespan.hyyz17200 = True
    app.router.lifespan_context = lifespan
