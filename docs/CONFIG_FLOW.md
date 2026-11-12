# Config Flow

## Purpose

Commission one EnOcean BLE switch from Bluetooth discovery and create one config entry with:

- `mac_address`
- `security_key`

## Current Flow (Implemented)

`user` (Add integration) aborts with `discovery_required`: a switch is always added from its
Bluetooth discovery (press any button on it).

1. `bluetooth` (discovery)
- Starts from Bluetooth discovery.
- Stores discovered MAC/title, the discovery payload, and initializes trace state.

2. `bluetooth_method` (menu)
- `qr_scan`: scan the module label QR code with the camera.
- `qr_text`: type or paste the QR code text.
- `commissioning`: manual commissioning (button sequence), below.

### From the QR code

`qr_text` (form, field `qr_code`)
- Validates the text with `qr_onboarding.validate_qr_for_device()`, then creates the entry.

"Back" in every branch returns to the `bluetooth_method` menu, i.e. restarts adding the switch.
Closing the dialog (X) does the same: a flow continued from a discovery is not deleted, and
reopening it re-runs the current step without input (`GET` on the flow). `qr_scan`, `qr_text` and
`commissioning_retry` treat being shown a second time that way as "reopened" and return to the
method menu (`_reopened()`). A running `commissioning` progress step cannot be reset; its retry
menu comes when it ends.

`qr_text` (form, field `qr_code`)
- Submitting the field empty goes back to `bluetooth_method`.

`qr_scan` (menu: `qr_text` = enter the text instead, `bluetooth_method` = back)
- Its description links to the scan page `/enocean-ble-scan?flow_id=<flow_id>` (relative link:
  it opens inside the frontend, and inside the HA app, not in a new window). The page is a hidden,
  admin-only frontend panel (`panel.py`, `frontend/enocean-ble-scan-panel.js`), registered once.
- A flow continued from a discovery is not deleted when the dialog closes, so the page moves the
  flow to `qr_text` (from either menu) and submits the scanned code there with the standard,
  authenticated config flow API (`POST /api/config/config_entries/flow/<flow_id>`).
- Reading the code, in order: the Companion app's native scanner (external bus `bar_code/scan`),
  the live camera, a photo of the label, the text field. Camera frames and photos are decoded with
  `BarcodeDetector`, else the decoder worker the HA frontend serves
  (`/static/js/qr-scanner-worker.min.js`). No third-party code is bundled.
- Validation errors are returned on the `qr_text` form; the page shows them with the
  integration's translations (`config.error.<code>`).
- Opened without `flow_id`, the page lists the EnOcean BLE flows in progress to pick one.

Validation (`validate_qr_for_device`), each failure has its own error code:
- `invalid_qr`: not a module label QR code (`30S<MAC>+Z<key>…`) nor free text with MAC + key.
- `qr_mac_mismatch`: the QR code address is not the discovered switch address.
- `qr_key_invalid`: the key verifies none of the telegrams received from the switch (AES-128 MIC
  check on data telegrams, key comparison on a commissioning telegram).
- `qr_no_telegram`: no telegram from the switch is known yet.

The scan page design is adapted from hass-pronote (delphiki/hass-pronote#229, MIT).

### Manual commissioning

3. `commissioning` (progress)
- Shows progress instructions to the user.
- Waits for a commissioning telegram (`len=26`) with a `120s` timeout.
- On success, parses and validates payload MAC and stores `security_key`.
- On timeout/invalid payload, ends with `show_progress_done` -> `commissioning_retry` (menu:
  `commissioning` = try again, `bluetooth_method` = back to the methods). A running progress step
  cannot be interrupted from the frontend; the choice comes when it ends.

4. `bluetooth_confirm` (explicit submit)
- Shows final confirmation once commissioning data is ready.
- User presses `Submit` to create the config entry.

## Important Behavior

- If a commissioning payload is already available for the active flow context, the flow can move to `bluetooth_confirm` immediately.
- `async_remove()` always logs flow removal and emits terminal trace if no entry was created.
- No business logic is done in frontend; state transitions are backend-driven.

## User-Facing Instruction Text

- Progress text comes from translation key `config.progress.waiting_commissioning`.
- Confirmation text comes from translation key `config.step.bluetooth_confirm.description`.
- Error texts are in `config.error.*`.
