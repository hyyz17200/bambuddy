"""The Enhanced Settings store: one JSON row per section, defaults filled in."""

import pytest
from httpx import AsyncClient
from pydantic import BaseModel, Field

from backend.app.hyyz17200 import enhanced_settings
from backend.app.hyyz17200.models import Hyyz17200Setting

URL = "/api/v1/hyyz17200/settings"


class Sample(BaseModel):
    enabled: bool = True
    count: int = Field(default=3, ge=1, le=9)


@pytest.fixture
def sample_section(monkeypatch):
    monkeypatch.setattr(enhanced_settings, "SECTIONS", {"sample": Sample})


@pytest.mark.asyncio
async def test_an_unsaved_section_reads_as_its_defaults(async_client: AsyncClient, sample_section):
    response = await async_client.get(URL)

    assert response.status_code == 200
    assert response.json() == {"sample": {"enabled": True, "count": 3}}


@pytest.mark.asyncio
async def test_a_saved_section_is_returned_and_kept(async_client: AsyncClient, sample_section):
    response = await async_client.put(f"{URL}/sample", json={"count": 5})

    # A field left out goes back to its default.
    assert response.status_code == 200
    assert response.json() == {"enabled": True, "count": 5}
    assert (await async_client.get(URL)).json() == {"sample": {"enabled": True, "count": 5}}

    await async_client.put(f"{URL}/sample", json={"enabled": False, "count": 2})
    assert (await async_client.get(URL)).json() == {"sample": {"enabled": False, "count": 2}}


@pytest.mark.asyncio
async def test_invalid_values_and_unknown_sections_are_refused(async_client: AsyncClient, sample_section):
    assert (await async_client.put(f"{URL}/sample", json={"count": 99})).status_code == 422
    assert (await async_client.put(f"{URL}/nope", json={})).status_code == 404
    assert (await async_client.get(URL)).json() == {"sample": {"enabled": True, "count": 3}}


@pytest.mark.asyncio
async def test_a_stored_value_that_no_longer_validates_reads_as_the_defaults(
    async_client: AsyncClient, db_session, sample_section
):
    db_session.add(Hyyz17200Setting(section="sample", value='{"count": 42}'))
    await db_session.commit()

    assert (await async_client.get(URL)).json() == {"sample": {"enabled": True, "count": 3}}
