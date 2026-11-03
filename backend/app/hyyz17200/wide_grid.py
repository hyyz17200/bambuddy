"""Wide screens fit more printer cards and camera tiles per row.

Upstream stops adding columns at 1280px wide: S cards 5 per row, M cards 3,
camera wall S 5 and M 4. From 1536px wide the frontend instead fits as many as
the page has room for, each at least ``min_width`` CSS pixels, up to
``max_columns``. The defaults never give fewer columns than upstream does at
1536px.
"""

from pydantic import BaseModel, Field


class GridLimit(BaseModel):
    max_columns: int = Field(ge=1, le=16)
    min_width: int = Field(ge=120, le=1200)


class WideGridSettings(BaseModel):
    enabled: bool = True
    printer_s: GridLimit = Field(default_factory=lambda: GridLimit(max_columns=8, min_width=220))
    printer_m: GridLimit = Field(default_factory=lambda: GridLimit(max_columns=6, min_width=340))
    camwall_s: GridLimit = Field(default_factory=lambda: GridLimit(max_columns=8, min_width=220))
    camwall_m: GridLimit = Field(default_factory=lambda: GridLimit(max_columns=6, min_width=280))
