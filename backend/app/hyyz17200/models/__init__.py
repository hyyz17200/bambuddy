"""The fork's tables, named hyyz17200_*.

Import each model module here: init_db() imports this package before create_all,
which is what creates the tables. Keep upstream's rows reachable by foreign key
rather than adding columns to upstream's tables.
"""

from backend.app.hyyz17200.models.hidden_fault import HiddenFault

__all__ = ["HiddenFault"]
