"""Constants for EnOcean BLE integration."""

from __future__ import annotations

DOMAIN = "enocean_ble"
INTEGRATION_NAME = "PTM 215B/PTM 216B"
PLATFORMS = ["event", "sensor"]

CONF_MAC_ADDRESS = "mac_address"
CONF_SECURITY_KEY = "security_key"
# False when a switch was added from its QR code before any telegram of it was received:
# the key is then verified by its first data telegram (absent = verified).
CONF_KEY_VERIFIED = "key_verified"
# Consecutive MIC failures of an unverified key before a Repairs issue is raised.
KEY_MISMATCH_THRESHOLD = 3
ISSUE_KEY_MISMATCH = "key_mismatch"

ENOCEAN_MANUFACTURER_ID = 0x03DA
ENOCEAN_MAC_PREFIX = "E2:15:"

# Admin-only frontend page (sidebar "EnOcean BLE") to add switches: scan a module
# label QR code (no button press needed), or finish adding a discovered switch:
# /enocean-ble-scan, ?scan=1 (start the camera), ?flow_id=<discovery flow>
SCAN_PANEL_URL_PATH = "enocean-ble-scan"
SCAN_PANEL_TITLE = "EnOcean BLE"
SCAN_PANEL_ICON = "mdi:qrcode-scan"
SCAN_PANEL_ELEMENT = "enocean-ble-scan-panel"
SCAN_PANEL_FILENAME = "enocean-ble-scan-panel.js"
SCAN_PANEL_STATIC_URL = "/enocean_ble_static"

EVENT_BUTTON_EVENT = "enocean_ble_button_event"
# Backward compatibility with existing automations.
EVENT_BUTTON_ACTION = "enocean_ble_button_action"
SIGNAL_BUTTON_EVENT = "enocean_ble_button_event_{entry_id}"

ATTR_BUTTON = "button"
ATTR_EVENT_TYPE = "event_type"
ATTR_RSSI = "rssi"
ATTR_SEQUENCE_COUNTER = "sequence_counter"
ATTR_MAC_ADDRESS = "mac_address"

SUPPORTED_BUTTONS = {"A0", "A1", "B0", "B1"}
SUPPORTED_EVENT_TYPES = {
    "press", "release", "orphan_release", "release_timeout",  # RAW
    "long_press", "long_release",                              # CALCULÉS (best-effort)
    "single_press",                                            # UX (robust)
}

DATA_TELEGRAM_MIN_LENGTH = 9
MIC_LENGTH = 4
LONG_PRESS_SECONDS = 1.2
RELEASE_TIMEOUT_SECONDS = 8.0

STATUS_BIT_ENERGY_BOW = 0x01
STATUS_BIT_A0 = 0x02
STATUS_BIT_A1 = 0x04
STATUS_BIT_B0 = 0x08
STATUS_BIT_B1 = 0x10

BUTTON_BIT_TO_NAME = {
    STATUS_BIT_A0: "A0",
    STATUS_BIT_A1: "A1",
    STATUS_BIT_B0: "B0",
    STATUS_BIT_B1: "B1",
}

BUTTON_ENTITY_DESCRIPTIONS = {
    "A0": "A0",
    "A1": "A1",
    "B0": "B0",
    "B1": "B1",
}
