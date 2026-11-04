"""The hyyz17200 fork's code (see .claude/rules/hyyz17200-fork.md)."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.app.core.config import settings
from backend.app.hyyz17200.api import router


def register(app: FastAPI) -> None:
    """Add the fork's routes and background work. Called from main.py with the
    upstream routers, after the app (and its lifespan) is built."""
    from backend.app.hyyz17200 import slice_as_designed

    app.include_router(router, prefix=settings.api_prefix)
    slice_as_designed.install()
    _wrap_lifespan(app)


def _wrap_lifespan(app: FastAPI) -> None:
    """Run the fork's startup and shutdown inside upstream's lifespan, rather
    than adding lines to it: after upstream's startup, before its shutdown."""
    upstream = app.router.lifespan_context
    if getattr(upstream, "hyyz17200", False):
        return

    @asynccontextmanager
    async def lifespan(app_: FastAPI):
        from backend.app.hyyz17200 import calibration_batch, slice_as_designed

        async with upstream(app_) as state:
            await _apply_settings()
            await calibration_batch.resume_at_startup()
            try:
                yield state
            finally:
                calibration_batch.runner.stop()
                slice_as_designed.runner.stop()

    lifespan.hyyz17200 = True
    app.router.lifespan_context = lifespan


async def _apply_settings() -> None:
    """Saved Enhanced Settings that the backend uses. A failure leaves the defaults."""
    import logging

    from backend.app.core.database import async_session
    from backend.app.hyyz17200 import enhanced_settings

    try:
        async with async_session() as db:
            await enhanced_settings.apply_all(db)
    except Exception:
        logging.getLogger(__name__).exception("Could not apply the hyyz17200 settings at startup")
