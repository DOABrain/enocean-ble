"""Tests for adding a discovered switch from its module label QR code."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

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


@pytest.fixture
def flows() -> Iterator[list[EnOceanBleConfigFlow]]:
    """Flows created by a test; their waiting add-step task is cancelled afterwards."""
    created: list[EnOceanBleConfigFlow] = []
    yield created
    for flow in created:
        flow._cancel_method_task()


async def _flow(
    hass: Any, flows: list[EnOceanBleConfigFlow], cached: list[SimpleNamespace]
) -> tuple[EnOceanBleConfigFlow, Any]:
    flow, result = await _discovered_flow(hass, cached)
    flows.append(flow)
    return flow, result


async def test_discovery_links_to_the_commissioning_page(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    """The dialog cannot host the methods: a progress step (no Submit) links to the page."""
    flow, result = await _flow(hass, flows, [_service_info()])
    assert result["type"] == FlowResultType.SHOW_PROGRESS
    assert result["step_id"] == "bluetooth_method"
    assert result["progress_action"] == "open_commissioning_page"
    placeholders = result["description_placeholders"]
    assert placeholders is not None
    assert placeholders["mac"] == MAC
    assert placeholders["error"] == ""
    # Relative link: it opens inside the frontend (and inside the HA app), never a new window.
    assert placeholders["page_url"] == "/enocean-ble-scan?flow_id=test-flow"
    # The step waits until the page submits; reopening it keeps the same task.
    task = result["progress_task"]
    assert not task.done()
    assert (await flow.async_step_bluetooth_method())["progress_task"] is task


async def test_qr_code_creates_entry(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    """Submitted by the commissioning page (scan, image or pasted data)."""
    flow, _ = await _flow(hass, flows, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["type"] == FlowResultType.SHOW_PROGRESS_DONE
    assert result["step_id"] == "qr_add"
    result = await flow.async_step_qr_add()
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_MAC_ADDRESS: MAC, CONF_SECURITY_KEY: KEY}


async def test_qr_code_uses_discovery_payload_when_cache_is_empty(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, _ = await _flow(hass, flows, [])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["step_id"] == "qr_add"


@pytest.mark.parametrize(
    ("raw", "error"),
    [
        ("not a qr code", "invalid_qr"),
        (OTHER_SWITCH_QR, "qr_mac_mismatch"),
        (OTHER_KEY_QR, "qr_key_invalid"),
    ],
)
async def test_qr_code_errors_stay_on_the_add_step(
    hass: Any, flows: list[EnOceanBleConfigFlow], raw: str, error: str
) -> None:
    flow, _ = await _flow(hass, flows, [_service_info()])
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[_service_info()]):
        result = await flow.async_step_bluetooth_method({"qr_code": raw})
    assert result["type"] == FlowResultType.SHOW_PROGRESS
    assert result["step_id"] == "bluetooth_method"
    assert result["description_placeholders"]["error"] == error


async def test_qr_code_without_any_telegram(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, _ = await _flow(hass, flows, [])
    flow._discovery_payload = None
    with patch.object(config_flow_module, "async_discovered_service_info", return_value=[]):
        result = await flow.async_step_bluetooth_method({"qr_code": QR})
    assert result["description_placeholders"]["error"] == "qr_no_telegram"


async def test_qr_add_without_accepted_code_returns_to_the_add_step(
    hass: Any, flows: list[EnOceanBleConfigFlow]
) -> None:
    flow, _ = await _flow(hass, flows, [_service_info()])
    assert (await flow.async_step_qr_add())["step_id"] == "bluetooth_method"


async def test_empty_input_keeps_waiting(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, _ = await _flow(hass, flows, [_service_info()])
    for empty in ({}, {"qr_code": "  ", "button_sequence": False}):
        result = await flow.async_step_bluetooth_method(empty)
        assert result["type"] == FlowResultType.SHOW_PROGRESS
        assert result["description_placeholders"]["error"] == ""


async def test_button_sequence_starts_commissioning(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, _ = await _flow(hass, flows, [_service_info()])
    result = await flow.async_step_bluetooth_method({"button_sequence": True})
    assert result["type"] == FlowResultType.SHOW_PROGRESS_DONE
    assert result["step_id"] == "commissioning"


async def test_flow_removal_cancels_the_waiting_task(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, result = await _flow(hass, flows, [_service_info()])
    task = result["progress_task"]
    flow.async_remove()
    await asyncio.sleep(0)
    assert task.cancelled()


async def test_commissioning_timeout_offers_retry_or_back(hass: Any, flows: list[EnOceanBleConfigFlow]) -> None:
    flow, _ = await _flow(hass, flows, [_service_info()])
    failed: asyncio.Future[None] = hass.loop.create_future()
    failed.set_exception(TimeoutError())
    flow._stage_task = failed  # type: ignore[assignment]
    result = await flow.async_step_commissioning()
    assert result["type"] == FlowResultType.SHOW_PROGRESS_DONE
    assert result["step_id"] == "commissioning_retry"
    result = await flow.async_step_commissioning_retry()
    assert result["type"] == FlowResultType.MENU
    assert result["menu_options"] == ["commissioning", "bluetooth_method"]
    # Reopened after the failure (dialog closed with X): back to the add step.
    assert (await flow.async_step_commissioning_retry())["step_id"] == "bluetooth_method"


def test_device_payloads_filters_by_address() -> None:
    infos = [
        _service_info(DATA_TELEGRAM),
        _service_info(b"\x01" * 9, address="E2:15:00:00:00:01"),
        _service_info(None),
    ]
    assert device_payloads(infos, MAC) == [DATA_TELEGRAM]
    assert device_payloads(infos, MAC.lower()) == [DATA_TELEGRAM]
