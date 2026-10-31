from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class HiddenFault(Base):
    """A printer fault code the user chose to stop being alerted about."""

    __tablename__ = "hyyz17200_hidden_fault"

    # Normalized: uppercase hex with no separators, 8 or 16 digits.
    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    note: Mapped[str] = mapped_column(String(200), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
