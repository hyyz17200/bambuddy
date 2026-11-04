"""Quick colour swatches: their defaults and validation, through the Enhanced Settings store."""

import pytest
from httpx import AsyncClient

URL = "/api/v1/hyyz17200/settings"


@pytest.mark.asyncio
async def test_unsaved_colors_keep_upstream_and_start_the_editor_from_its_list(async_client: AsyncClient):
    colors = (await async_client.get(URL)).json()["quick_colors"]

    assert colors["customized"] is False
    assert colors["basic"][:2] == [{"name": "White", "hex": "FFFFFF"}, {"name": "Black", "hex": "000000"}]
    assert len(colors["basic"]) == 8
    assert len(colors["extended"]) == 24


@pytest.mark.asyncio
async def test_saved_colors_are_kept_with_hex_uppercased_and_names_trimmed(async_client: AsyncClient):
    wanted = {
        "customized": True,
        "basic": [{"name": " 竹绿 ", "hex": "a1b2c3"}],
        "extended": [],
    }

    response = await async_client.put(f"{URL}/quick_colors", json=wanted)

    assert response.status_code == 200
    expected = {"customized": True, "basic": [{"name": "竹绿", "hex": "A1B2C3"}], "extended": []}
    assert response.json() == expected
    assert (await async_client.get(URL)).json()["quick_colors"] == expected


@pytest.mark.parametrize(
    "basic",
    [
        [{"name": "Red", "hex": "FF00"}],
        [{"name": "Clear", "hex": "00000000"}],
        [{"name": "#Red", "hex": "#FF0000"}],
        [{"name": "  ", "hex": "FF0000"}],
        [{"name": "Red", "hex": "FF0000"}, {"name": "Also red", "hex": "ff0000"}],
        [{"name": f"C{i}", "hex": f"{i:06X}"} for i in range(33)],
    ],
)
@pytest.mark.asyncio
async def test_bad_colors_are_refused(async_client: AsyncClient, basic):
    response = await async_client.put(f"{URL}/quick_colors", json={"customized": True, "basic": basic})

    assert response.status_code == 422
    assert (await async_client.get(URL)).json()["quick_colors"]["customized"] is False


@pytest.mark.asyncio
async def test_a_hex_in_both_lists_is_refused(async_client: AsyncClient):
    body = {
        "customized": True,
        "basic": [{"name": "Red", "hex": "FF0000"}],
        "extended": [{"name": "Red again", "hex": "FF0000"}],
    }

    assert (await async_client.put(f"{URL}/quick_colors", json=body)).status_code == 422
