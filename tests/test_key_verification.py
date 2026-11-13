"""Tests for verifying a QR code key on the switch's first telegram (scan-first adding)."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.enocean_ble import _note_key_failure, _note_key_success
from custom_components.enocean_ble.const import (
    CONF_KEY_VERIFIED,
    CONF_MAC_ADDRESS,
    CONF_SECURITY_KEY,
    DOMAIN,
    KEY_MISMATCH_THRESHOLD,
)

MAC = "E2:15:00:00:19:B8"
KEY = "3dda31ad44767ae3ce56dce2b3ce2abb"


def _entry(hass: Any, *, verified: bool) -> tuple[MockConfigEntry, dict[str, Any]]:
    data: dict[str, Any] = {CONF_MAC_ADDRESS: MAC, CONF_SECURITY_KEY: KEY}
    if not verified:
        data[CONF_KEY_VERIFIED] = False
    entry = MockConfigEntry(domain=DOMAIN, title="Switch", unique_id=MAC, data=data)
    entry.add_to_hass(hass)
    entry_data = {CONF_MAC_ADDRESS: MAC, CONF_KEY_VERIFIED: verified, "key_failures": 0}
    return entry, entry_data


def _issue(hass: Any, entry: MockConfigEntry) -> Any:
    return ir.async_get(hass).async_get_issue(DOMAIN, f"key_mismatch_{entry.entry_id}")


async def test_first_good_telegram_verifies_the_key(hass: Any) -> None:
    entry, entry_data = _entry(hass, verified=False)
    _note_key_success(hass, entry, entry_data)
    assert entry_data[CONF_KEY_VERIFIED] is True
    assert entry.data[CONF_KEY_VERIFIED] is True


async def test_repeated_mic_failures_raise_a_repairs_issue(hass: Any) -> None:
    entry, entry_data = _entry(hass, verified=False)
    for _ in range(KEY_MISMATCH_THRESHOLD - 1):
        _note_key_failure(hass, entry, entry_data)
    assert _issue(hass, entry) is None  # a single bad frame is not enough
    _note_key_failure(hass, entry, entry_data)
    assert _issue(hass, entry) is not None
    # A telegram that verifies clears it again.
    _note_key_success(hass, entry, entry_data)
    assert _issue(hass, entry) is None
    assert entry.data[CONF_KEY_VERIFIED] is True


async def test_verified_key_never_raises_an_issue(hass: Any) -> None:
    entry, entry_data = _entry(hass, verified=True)
    for _ in range(KEY_MISMATCH_THRESHOLD + 2):
        _note_key_failure(hass, entry, entry_data)
    assert _issue(hass, entry) is None
    assert CONF_KEY_VERIFIED not in entry.data
