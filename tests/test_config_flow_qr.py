"""Tests for adding a discovered switch from its module label QR code."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.data_entry_flow import FlowResultType

from custom_components.enocean_ble import config_flow as config_flow_module
from custom_components.enocean_ble.config_flow import EnOceanBleConfigFlow
from custom_components.enocean_ble.const import (
    CONF_MAC_ADDRESS,
    CONF_SECURITY_KEY,
    DOMAIN,
    ENOCEAN_MANUFACTURER_ID,
)
from custom_components.enocean_ble.qr_onboarding import device_payloads

# PTM 215B User Manual v2.2, Appendix C.3.1: address, key and a real data telegram.
MAC = "E2:15:00:00:19:B8"
KEY = "3dda31ad44767ae3ce56dce2b3ce2abb"
QR = "30SE215000019B8+Z3DDA31AD44767AE3CE56DCE2B3CE2ABB+30PS3221-A215"
DATA_TELEGRAM = bytes.fromhex("5D04000011B2FA88FF")
OTHER_KEY_QR = "30SE215000019B8+Z00112233445566778899AABBCCDDEEFF+30PS3221-A215"
OTHER_SWITCH_QR = "30SE21500000001+Z3DDA31AD44767AE3CE56DCE2B3CE2ABB+30PS3221-A215"


def _service_info(payload: bytes | None = DATA_TELEGRAM, address: str = MAC) -> SimpleNamespace:
    return SimpleNamespace(
        address=address,
        name=address,
        source="local",
        rssi=-60,
        time=1.0,
        manufacturer_data={ENOCEAN_MANUFACTURER_ID: payload} if payload is not None else {},
    )


async def _discovered_flow(hass: Any, cached: list[SimpleNamespace]) -> tuple[EnOceanBleConfigFlow, Any]:
    """Run the Bluetooth discovery step; ``cached`` is what the bluetooth cache returns."""
    flow = EnOceanBleConfigFlow()
    flow.hass = hass
    flow.handler = DOMAIN
    flow.flow_id = "test-flow"
    flow.context = {"source": "bluetooth"}
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=cached):
        result = await flow.async_step_bluetooth(_service_info())  # type: ignore[arg-type]
    return flow, result


async def test_user_step_requires_discovery(hass: Any) -> None:
    flow = EnOceanBleConfigFlow()
    flow.hass = hass
    result = await flow.async_step_user()
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "discovery_required"


async def test_discovery_shows_method_menu(hass: Any) -> None:
    _, result = await _discovered_flow(hass, [_service_info()])
    assert result["type"] == FlowResultType.MENU
    assert result["step_id"] == "bluetooth_method"
    assert result["menu_options"] == ["qr_scan", "qr_text", "commissioning"]
    assert result["description_placeholders"]["mac"] == MAC


async def test_qr_text_creates_entry(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_qr_text({"qr_code": QR})
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_MAC_ADDRESS: MAC, CONF_SECURITY_KEY: KEY}


async def test_qr_text_uses_discovery_payload_when_cache_is_empty(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_qr_text({"qr_code": QR})
    assert result["type"] == FlowResultType.CREATE_ENTRY


@pytest.mark.parametrize(
    ("raw", "error"),
    [
        ("not a qr code", "invalid_qr"),
        (OTHER_SWITCH_QR, "qr_mac_mismatch"),
        (OTHER_KEY_QR, "qr_key_invalid"),
    ],
)
async def test_qr_text_errors(hass: Any, raw: str, error: str) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_qr_text({"qr_code": raw})
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "qr_text"
    assert result["errors"] == {"base": error}


async def test_qr_text_without_any_telegram(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [])
    flow._discovery_payload = None
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_qr_text({"qr_code": QR})
    assert result["errors"] == {"base": "qr_no_telegram"}


async def test_qr_scan_shows_form_with_in_app_scan_link(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    register = AsyncMock()
    with patch.object(config_flow_module, "async_register_scan_panel", register):
        result = await flow.async_step_qr_scan()
    register.assert_awaited_once()
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "qr_scan"
    placeholders = result["description_placeholders"]
    assert placeholders is not None
    # Relative link: it opens inside the frontend (and inside the HA app), never a new window.
    assert placeholders["scan_url"] == "/enocean-ble-scan?flow_id=test-flow"
    assert placeholders["mac"] == MAC


async def test_qr_scan_submitted_code_creates_entry(hass: Any) -> None:
    """The scan page (or the text field of the step) submits the code to qr_scan."""
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_qr_scan({"qr_code": QR})
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_MAC_ADDRESS: MAC, CONF_SECURITY_KEY: KEY}


@pytest.mark.parametrize(
    ("raw", "error"),
    [
        ("not a qr code", "invalid_qr"),
        (OTHER_SWITCH_QR, "qr_mac_mismatch"),
        (OTHER_KEY_QR, "qr_key_invalid"),
    ],
)
async def test_qr_scan_errors_stay_on_scan_step(hass: Any, raw: str, error: str) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with (
        patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]),
        patch.object(config_flow_module, "async_register_scan_panel", AsyncMock()),
    ):
        result = await flow.async_step_qr_scan({"qr_code": raw})
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "qr_scan"
    assert result["errors"] == {"base": error}


def test_device_payloads_filters_by_address() -> None:
    infos = [
        _service_info(DATA_TELEGRAM),
        _service_info(b"\x01" * 9, address="E2:15:00:00:00:01"),
        _service_info(None),
    ]
    assert device_payloads(infos, MAC) == [DATA_TELEGRAM]
    assert device_payloads(infos, MAC.lower()) == [DATA_TELEGRAM]
