"""The fork's lock on the in-app updater (see .claude/rules/hyyz17200-fork.md)."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from backend.app.api.routes import updates as updates_module


@pytest.mark.asyncio
async def test_apply_refuses_on_a_git_install_and_starts_nothing(async_client: AsyncClient):
    updates_module._update_status = {"status": "idle", "progress": 0, "message": "", "error": None}

    with (
        patch.object(updates_module, "_is_ha_addon", return_value=False),
        patch.object(updates_module, "_is_docker_environment", return_value=False),
        patch.object(updates_module, "_is_windows_installer_install", return_value=False),
        patch.object(updates_module, "_discover_target_release", new_callable=AsyncMock) as discover,
        patch.object(updates_module, "_perform_update", new_callable=AsyncMock) as perform,
    ):
        response = await async_client.post("/api/v1/updates/apply")

    body = response.json()
    assert body["success"] is False
    assert "disabled on this fork" in body["message"]
    discover.assert_not_called()
    perform.assert_not_called()
    assert updates_module._update_status["status"] == "idle"
