from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, func, true
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class MaintenanceDispatch(Base):
    """A queue job sent as maintenance G-code (maintenance_jobs.py).

    Its completion leaves upstream's plate-clear flag alone, and with
    ``uses_plate`` off also upstream's plate changer count (#3575). Kept in the
    database so that still holds after a Bambuddy restart mid-job.

    Rows of jobs no longer pending or printing are pruned whenever a job is
    sent, so a queue id that SQLite hands out again never finds an old row.
    """

    __tablename__ = "hyyz17200_maintenance_dispatch"

    queue_item_id: Mapped[int] = mapped_column(ForeignKey("print_queue.id", ondelete="CASCADE"), primary_key=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Take a plate off upstream's plate changer count when it finishes.
    uses_plate: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
