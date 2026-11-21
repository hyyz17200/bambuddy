"""The browser tab title as printer-state counts instead of one print's progress.

Upstream's "Print progress in tab" shows the soonest-finishing print, which says
nothing on a farm. Turned on, the tab reads e.g. "▶12 ⏸1 ✓5 ⚠2 ✕3 · Bambuddy":
the states, in the order and with the labels set here. The counts are the
printer page's status bar's; the frontend does the counting (tabTitle/).

The defaults are mirrored in the frontend's tabTitleSettings.ts.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

CountKey = Literal["printing", "paused", "finished", "idle", "error", "offline", "total"]

DEFAULT_LABELS: dict[str, str] = {
    "printing": "▶",
    "paused": "⏸",
    "finished": "✓",
    "idle": "○",
    "error": "⚠",
    "offline": "✕",
    "total": "Σ",
}
DEFAULT_KEYS = ("printing", "paused", "finished", "error", "offline")


class TabTitleItem(BaseModel):
    key: CountKey
    # Empty shows the bare number.
    label: str = Field(default="", max_length=12)


def _default_items() -> list[TabTitleItem]:
    return [TabTitleItem(key=key, label=DEFAULT_LABELS[key]) for key in DEFAULT_KEYS]


class TabTitleSettings(BaseModel):
    """The Enhanced Settings' tab title section."""

    enabled: bool = False
    items: list[TabTitleItem] = Field(default_factory=_default_items, max_length=len(DEFAULT_LABELS))
    hide_zero: bool = False
    show_app_name: bool = True

    @model_validator(mode="after")
    def _unique_keys(self) -> "TabTitleSettings":
        keys = [item.key for item in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError("each count can be shown once")
        return self
