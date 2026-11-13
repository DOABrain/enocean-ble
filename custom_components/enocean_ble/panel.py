"""Admin-only frontend page (sidebar "EnOcean BLE") to add switches.

The page is a regular Home Assistant frontend panel, so it runs inside the HA app
(native barcode scanner) and every request it makes is authenticated. It reads the QR
code and submits it to the waiting config flow through the standard config flow API;
validation stays in the flow. No HTTP view and no third-party JavaScript are added.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

from .const import (
    DOMAIN,
    SCAN_PANEL_ELEMENT,
    SCAN_PANEL_FILENAME,
    SCAN_PANEL_ICON,
    SCAN_PANEL_STATIC_URL,
    SCAN_PANEL_TITLE,
    SCAN_PANEL_URL_PATH,
)

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent / "frontend"
DATA_PANEL_REGISTERED = "scan_panel_registered"


def scan_panel_path(flow_id: str | None) -> str:
    """In-app path of the add page: for a discovered switch's flow, or to scan a new one."""
    if flow_id is None:
        return f"/{SCAN_PANEL_URL_PATH}?scan=1"
    return f"/{SCAN_PANEL_URL_PATH}?flow_id={flow_id}"


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_register_scan_panel(hass: Any) -> None:
    """Serve the page script and register the hidden panel, once per HA run."""
    if getattr(hass, "http", None) is None:
        return
    domain_data: dict[str, Any] = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(DATA_PANEL_REGISTERED):
        return
    domain_data[DATA_PANEL_REGISTERED] = True

    from homeassistant.components import panel_custom
    from homeassistant.components.http import StaticPathConfig  # type: ignore[attr-defined]

    script = FRONTEND_DIR / SCAN_PANEL_FILENAME
    digest = await hass.async_add_executor_job(_file_digest, script)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(SCAN_PANEL_STATIC_URL, str(FRONTEND_DIR), False)]
    )
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=SCAN_PANEL_ELEMENT,
        frontend_url_path=SCAN_PANEL_URL_PATH,
        module_url=f"{SCAN_PANEL_STATIC_URL}/{SCAN_PANEL_FILENAME}?v={digest}",
        sidebar_title=SCAN_PANEL_TITLE,
        sidebar_icon=SCAN_PANEL_ICON,
        require_admin=True,
        config={},
    )
    _LOGGER.debug("scan_panel_registered url_path=%s digest=%s", SCAN_PANEL_URL_PATH, digest)
