"""The fork's one say in upstream's plate-clear flag.

After every print upstream raises "awaiting plate clear" on the printer
(main.py's completion callback). That is right for a print, which leaves an
object on the bed, and wrong for jobs of this fork that leave nothing there:

- a completed batch calibration (calibration_batch.skips_plate_clear).

main.py asks :func:`skips_plate_clear` in that one place and leaves the flag
as it was when the answer is yes. Only a completed job can skip: a failed or
cancelled one may have stopped halfway.
"""

import logging
from collections.abc import Callable

from backend.app.hyyz17200 import calibration_batch

logger = logging.getLogger(__name__)


async def skips_plate_clear(printer_id: int, data: dict, session_factory: Callable) -> bool:
    """Whether this completion leaves the plate-clear flag alone.

    ``session_factory`` is main.py's ``async_session``, passed in so tests that
    patch it there also cover this. Never raises; an error means "no".
    """
    if data.get("status") != "completed":
        return False
    try:
        async with session_factory() as db:
            if await calibration_batch.skips_plate_clear(db, printer_id, data):
                logger.info("hyyz17200: printer %s finished a batch calibration, no plate-clear check", printer_id)
                return True
    except Exception:
        logger.warning("hyyz17200: plate-clear hook failed for printer %s", printer_id, exc_info=True)
    return False
