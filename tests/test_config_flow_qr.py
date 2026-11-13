"""Tests for adding a discovered switch from its module label QR code."""

from __future__ import annotations

import asyncio
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


async def test_discovery_shows_one_add_form(hass: Any) -> None:
    """Like the add page: scan / photo links, QR code text, or the button sequence."""
    _, result = await _discovered_flow(hass, [_service_info()])
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "bluetooth_method"
    assert [field["name"] for field in result["data_schema"].schema] == ["qr_code", "button_sequence"]
    placeholders = result["description_placeholders"]
    assert placeholders is not None
    assert placeholders["mac"] == MAC
    # Relative links: they open inside the frontend (and inside the HA app), never a new window.
    assert placeholders["scan_url"] == "/enocean-ble-scan?flow_id=test-flow"
    assert placeholders["photo_url"] == "/enocean-ble-scan?flow_id=test-flow&photo=1"


async def test_qr_code_creates_entry(hass: Any) -> None:
    """Pasted in the form, or submitted by the add page after a scan or a photo."""
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_MAC_ADDRESS: MAC, CONF_SECURITY_KEY: KEY}


async def test_qr_code_uses_discovery_payload_when_cache_is_empty(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["type"] == FlowResultType.CREATE_ENTRY


@pytest.mark.parametrize(
    ("raw", "error"),
    [
        ("not a qr code", "invalid_qr"),
        (OTHER_SWITCH_QR, "qr_mac_mismatch"),
        (OTHER_KEY_QR, "qr_key_invalid"),
    ],
)
async def test_qr_code_errors_stay_on_the_add_form(hass: Any, raw: str, error: str) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_bluetooth_method({"qr_code": raw})
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "bluetooth_method"
    assert result["errors"] == {"base": error}


async def test_qr_code_without_any_telegram(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [])
    flow._discovery_payload = None
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["errors"] == {"base": "qr_no_telegram"}


async def test_nothing_chosen_asks_for_a_method(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    for empty in ({}, {"qr_code": "  ", "button_sequence": False}):
        result = await flow.async_step_bluetooth_method(empty)
        assert result["step_id"] == "bluetooth_method"
        assert result["errors"] == {"base": "choose_method"}


async def test_button_sequence_starts_commissioning(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    with patch.object(flow, "async_step_commissioning", AsyncMock(return_value={"step_id": "commissioning"})) as step:
        result = await flow.async_step_bluetooth_method({"button_sequence": True})
    step.assert_awaited_once()
    assert result["step_id"] == "commissioning"


async def test_commissioning_timeout_offers_retry_or_back(hass: Any) -> None:
    flow, _ = await _discovered_flow(hass, [_service_info()])
    failed: asyncio.Future[None] = hass.loop.create_future()
    failed.set_exception(TimeoutError())
    flow._stage_task = failed  # type: ignore[assignment]
    result = await flow.async_step_commissioning()
    assert result["type"] == FlowResultType.SHOW_PROGRESS_DONE
    assert result["step_id"] == "commissioning_retry"
    result = await flow.async_step_commissioning_retry()
    assert result["type"] == FlowResultType.MENU
    assert result["menu_options"] == ["commissioning", "bluetooth_method"]
    # Reopened after the failure (dialog closed with X): back to the add form.
    assert (await flow.async_step_commissioning_retry())["step_id"] == "bluetooth_method"


def test_device_payloads_filters_by_address() -> None:
    infos = [
        _service_info(DATA_TELEGRAM),
        _service_info(b"\x01" * 9, address="E2:15:00:00:00:01"),
        _service_info(None),
    ]
    assert device_payloads(infos, MAC) == [DATA_TELEGRAM]
    assert device_payloads(infos, MAC.lower()) == [DATA_TELEGRAM]
