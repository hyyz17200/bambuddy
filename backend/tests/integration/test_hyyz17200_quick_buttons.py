"""The quick buttons settings: hide the bug-report button, show a Select shortcut (hyyz17200)."""

import pytest
from httpx import AsyncClient

from backend.app.hyyz17200 import enhanced_settings
from backend.app.hyyz17200.quick_buttons import QuickButtonSettings

URL = "/api/v1/hyyz17200/settings"


def test_it_is_an_enhanced_settings_section():
    assert enhanced_settings.SECTIONS["quick_buttons"] is QuickButtonSettings


@pytest.mark.asyncio
async def test_it_starts_as_upstream(async_client: AsyncClient):
    section = (await async_client.get(URL)).json()["quick_buttons"]

    assert section == {"hide_bug_report": False, "select_button": False}


@pytest.mark.asyncio
async def test_saved_switches_are_kept(async_client: AsyncClient):
    value = {"hide_bug_report": True, "select_button": True}

    assert (await async_client.put(f"{URL}/quick_buttons", json=value)).status_code == 200
    assert (await async_client.get(URL)).json()["quick_buttons"] == value
