"""Tests for the hidden QR scan panel registration."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

from custom_components.enocean_ble.const import (
    DOMAIN,
    SCAN_PANEL_ELEMENT,
    SCAN_PANEL_FILENAME,
    SCAN_PANEL_URL_PATH,
)
from custom_components.enocean_ble.panel import (
    FRONTEND_DIR,
    async_register_scan_panel,
    scan_panel_path,
)


def test_scan_panel_script_is_packaged() -> None:
    script = FRONTEND_DIR / SCAN_PANEL_FILENAME
    assert script.is_file()
    text = script.read_text(encoding="utf-8")
    # The page defines the element the panel is registered with.
    assert f'customElements.define("{SCAN_PANEL_ELEMENT}"' in text
    # It reuses the decoder the HA frontend serves instead of bundling one.
    assert "/static/js/qr-scanner-worker.min.js" in text


def test_scan_panel_path() -> None:
    assert scan_panel_path("abc") == f"/{SCAN_PANEL_URL_PATH}?flow_id=abc"
    assert scan_panel_path(None) == f"/{SCAN_PANEL_URL_PATH}?scan=1"


async def test_register_skips_without_http() -> None:
    hass = SimpleNamespace(data={})
    await async_register_scan_panel(hass)
    assert hass.data == {}


async def test_register_once_in_sidebar_admin_only(hass: Any) -> None:
    register_panel = AsyncMock()
    hass.http = SimpleNamespace(async_register_static_paths=AsyncMock())
    with patch("homeassistant.components.panel_custom.async_register_panel", register_panel):
        await async_register_scan_panel(hass)
        await async_register_scan_panel(hass)
    register_panel.assert_awaited_once()
    assert register_panel.await_args is not None
    kwargs = register_panel.await_args.kwargs
    assert kwargs["frontend_url_path"] == SCAN_PANEL_URL_PATH
    assert kwargs["webcomponent_name"] == SCAN_PANEL_ELEMENT
    assert kwargs["sidebar_title"] == "EnOcean BLE"
    assert kwargs["require_admin"] is True
    assert hass.data[DOMAIN]["scan_panel_registered"] is True
