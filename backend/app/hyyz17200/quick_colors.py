"""The quick colour swatches under "Custom color" in the AMS slot dialog and the spool form.

Upstream hardcodes them, and each dialog has its own list. While ``customized``
is off, each dialog keeps upstream's. Turned on, both show ``basic`` up front
and ``extended`` behind their "more" toggle. The spool form's transparent
"Clear" swatch is not a colour and always stays.

The defaults are the AMS dialog's upstream lists, mirrored in the frontend's
quickColors.ts: they are where the editor starts.
"""

from pydantic import BaseModel, Field, field_validator, model_validator


class QuickColor(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    hex: str = Field(pattern=r"^[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name is empty")
        return value

    @field_validator("hex")
    @classmethod
    def _upper_hex(cls, value: str) -> str:
        return value.upper()


def _colors(*pairs: tuple[str, str]) -> list[QuickColor]:
    return [QuickColor(name=name, hex=hex_) for name, hex_ in pairs]


DEFAULT_BASIC = (
    ("White", "FFFFFF"),
    ("Black", "000000"),
    ("Red", "FF0000"),
    ("Blue", "0000FF"),
    ("Green", "00AA00"),
    ("Yellow", "FFFF00"),
    ("Orange", "FFA500"),
    ("Gray", "808080"),
)

DEFAULT_EXTENDED = (
    ("Cyan", "00FFFF"),
    ("Magenta", "FF00FF"),
    ("Purple", "800080"),
    ("Pink", "FFC0CB"),
    ("Brown", "8B4513"),
    ("Beige", "F5F5DC"),
    ("Navy", "000080"),
    ("Teal", "008080"),
    ("Lime", "32CD32"),
    ("Gold", "FFD700"),
    ("Silver", "C0C0C0"),
    ("Maroon", "800000"),
    ("Olive", "808000"),
    ("Coral", "FF7F50"),
    ("Salmon", "FA8072"),
    ("Turquoise", "40E0D0"),
    ("Violet", "EE82EE"),
    ("Indigo", "4B0082"),
    ("Chocolate", "D2691E"),
    ("Tan", "D2B48C"),
    ("Slate", "708090"),
    ("Charcoal", "36454F"),
    ("Ivory", "FFFFF0"),
    ("Cream", "FFFDD0"),
)


class QuickColorSettings(BaseModel):
    customized: bool = False
    basic: list[QuickColor] = Field(default_factory=lambda: _colors(*DEFAULT_BASIC), max_length=32)
    extended: list[QuickColor] = Field(default_factory=lambda: _colors(*DEFAULT_EXTENDED), max_length=64)

    @model_validator(mode="after")
    def _unique_hex(self) -> "QuickColorSettings":
        # The dialogs key swatches by hex and show both lists side by side.
        seen: set[str] = set()
        for color in [*self.basic, *self.extended]:
            if color.hex in seen:
                raise ValueError(f"#{color.hex} appears twice")
            seen.add(color.hex)
        return self
