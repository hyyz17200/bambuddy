"""The tab title override's settings: printer-state counts in the browser tab (hyyz17200)."""

import pytest
from httpx import AsyncClient

from backend.app.hyyz17200 import enhanced_settings
from backend.app.hyyz17200.tab_title import DEFAULT_LABELS, TabTitleSettings

URL = "/api/v1/hyyz17200/settings"


def test_it_is_an_enhanced_settings_section():
    assert enhanced_settings.SECTIONS["tab_title"] is TabTitleSettings


@pytest.mark.asyncio
async def test_it_starts_off_with_the_status_bar_counts(async_client: AsyncClient):
    section = (await async_client.get(URL)).json()["tab_title"]

    assert section == {
        "enabled": False,
        "items": [
            {"key": key, "label": DEFAULT_LABELS[key]} for key in ("printing", "paused", "finished", "error", "offline")
        ],
        "hide_zero": False,
        "show_app_name": True,
    }


@pytest.mark.asyncio
async def test_a_saved_order_and_labels_are_kept(async_client: AsyncClient):
    value = {
        "enabled": True,
        "items": [{"key": "offline", "label": "离线"}, {"key": "total", "label": ""}],
        "hide_zero": True,
        "show_app_name": False,
    }

    assert (await async_client.put(f"{URL}/tab_title", json=value)).status_code == 200
    assert (await async_client.get(URL)).json()["tab_title"] == value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "items",
    [
        [{"key": "printing"}, {"key": "printing"}],
        [{"key": "queued"}],
        [{"key": "printing", "label": "x" * 13}],
    ],
    ids=["repeated", "unknown", "label-too-long"],
)
async def test_bad_items_are_refused(async_client: AsyncClient, items):
    response = await async_client.put(f"{URL}/tab_title", json={"enabled": True, "items": items})

    assert response.status_code == 422
    assert (await async_client.get(URL)).json()["tab_title"]["enabled"] is False
