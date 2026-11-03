from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class PlateSwapDispatch(Base):
    """A queue job sent with End G-code actually injected into it.

    Written at dispatch, the only moment that knows whether injection worked:
    on failure upstream sends the original file, which has no swap in it. Kept
    in the database so the answer survives a Bambuddy restart mid-print.

    No delete listener is needed for reused queue ids: every dispatch rewrites
    its job's row, so a row left by a deleted job is replaced before it can be
    read for the new one.
    """

    __tablename__ = "hyyz17200_plate_swap_dispatch"

    queue_item_id: Mapped[int] = mapped_column(ForeignKey("print_queue.id", ondelete="CASCADE"), primary_key=True)
    dispatched_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
