"""The Enhanced Settings page's values: one JSON row per section in hyyz17200_setting.

Each patch that wants a setting adds a pydantic model to SECTIONS. Every field
needs a default, because a section nobody has saved yet reads as its defaults,
and so does a stored value that no longer validates after the model changed.

Anyone who can see the printers can read every section (the printer page and
the camera wall need them to draw), so nothing secret belongs here.
"""

import logging

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.hyyz17200.models.setting import Hyyz17200Setting
from backend.app.hyyz17200.wide_grid import WideGridSettings

logger = logging.getLogger(__name__)

SECTIONS: dict[str, type[BaseModel]] = {
    "wide_grid": WideGridSettings,
}


async def read_section(db: AsyncSession, section: str) -> BaseModel:
    model = SECTIONS[section]
    row = await db.get(Hyyz17200Setting, section)
    if row is not None:
        try:
            return model.model_validate_json(row.value)
        except ValidationError:
            logger.warning("Stored hyyz17200 settings for %r no longer validate; using the defaults", section)
    return model()


async def read_all(db: AsyncSession) -> dict[str, dict]:
    return {section: (await read_section(db, section)).model_dump() for section in SECTIONS}


async def write_section(db: AsyncSession, section: str, value: BaseModel) -> None:
    row = await db.get(Hyyz17200Setting, section)
    if row is None:
        db.add(Hyyz17200Setting(section=section, value=value.model_dump_json()))
    else:
        row.value = value.model_dump_json()
    await db.commit()
