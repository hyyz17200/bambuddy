"""Wide grid settings: their defaults and limits, through the Enhanced Settings store."""

import pytest
from httpx import AsyncClient

from backend.app.hyyz17200.models import Hyyz17200Setting  # noqa: F401  (create_all needs the table)

URL = "/api/v1/hyyz17200/settings"
GRIDS = ("printer_s", "printer_m", "printer_l", "printer_xl", "camwall_s", "camwall_m", "camwall_l", "camwall_xl")
DEFAULTS = {
    "enabled": True,
    "printer_s": {"max_columns": 8, "min_width": 220, "phone_columns": 1},
    "printer_m": {"max_columns": 6, "min_width": 340, "phone_columns": 1},
    "camwall_s": {"max_columns": 8, "min_width": 220, "phone_columns": 1},
    "printer_l": {"max_columns": 2, "min_width": 520, "phone_columns": 1},
    "printer_xl": {"max_columns": 1, "min_width": 800, "phone_columns": 1},
    "camwall_m": {"max_columns": 6, "min_width": 280, "phone_columns": 1},
    "camwall_l": {"max_columns": 2, "min_width": 480, "phone_columns": 1},
    "camwall_xl": {"max_columns": 1, "min_width": 800, "phone_columns": 1},
}


@pytest.mark.asyncio
async def test_unsaved_settings_read_as_the_defaults(async_client: AsyncClient):
    assert (await async_client.get(URL)).json()["wide_grid"] == DEFAULTS


@pytest.mark.asyncio
async def test_a_saved_grid_is_kept(async_client: AsyncClient):
    wanted = DEFAULTS | {"enabled": False, "printer_s": {"max_columns": 10, "min_width": 200, "phone_columns": 2}}

    response = await async_client.put(f"{URL}/wide_grid", json=wanted)

    assert response.status_code == 200
    assert (await async_client.get(URL)).json()["wide_grid"] == wanted


@pytest.mark.parametrize(
    "grid",
    [{"max_columns": 0, "min_width": 220}, {"max_columns": 17, "min_width": 220}, {"max_columns": 8, "min_width": 100}],
)
@pytest.mark.asyncio
async def test_out_of_range_values_are_refused(async_client: AsyncClient, grid):
    response = await async_client.put(f"{URL}/wide_grid", json=DEFAULTS | {"printer_m": grid})

    assert response.status_code == 422
    assert (await async_client.get(URL)).json()["wide_grid"] == DEFAULTS


@pytest.mark.asyncio
async def test_phones_default_to_upstream_one_per_row(async_client: AsyncClient):
    grids = (await async_client.get(URL)).json()["wide_grid"]

    assert {grids[key]["phone_columns"] for key in GRIDS} == {1}


@pytest.mark.parametrize("phone_columns", [0, 5])
@pytest.mark.asyncio
async def test_phone_columns_out_of_range_are_refused(async_client: AsyncClient, phone_columns):
    grid = DEFAULTS["printer_s"] | {"phone_columns": phone_columns}

    response = await async_client.put(f"{URL}/wide_grid", json=DEFAULTS | {"printer_s": grid})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_a_grid_saved_before_phone_columns_existed_reads_as_one_per_row(async_client: AsyncClient):
    old = {"enabled": True} | {
        key: {"max_columns": DEFAULTS[key]["max_columns"], "min_width": DEFAULTS[key]["min_width"]} for key in GRIDS
    }

    response = await async_client.put(f"{URL}/wide_grid", json=old)

    assert response.status_code == 200
    assert (await async_client.get(URL)).json()["wide_grid"] == DEFAULTS


@pytest.mark.asyncio
async def test_a_grid_saved_before_l_and_xl_existed_gets_their_defaults(async_client: AsyncClient):
    old = {key: DEFAULTS[key] for key in ("enabled", "printer_s", "printer_m", "camwall_s", "camwall_m")}

    response = await async_client.put(
        f"{URL}/wide_grid", json=old | {"printer_s": {"max_columns": 9, "min_width": 220, "phone_columns": 2}}
    )

    assert response.status_code == 200
    assert (await async_client.get(URL)).json()["wide_grid"] == DEFAULTS | {
        "printer_s": {"max_columns": 9, "min_width": 220, "phone_columns": 2}
    }
