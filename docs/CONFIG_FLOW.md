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

2. `bluetooth_method` (progress step `open_commissioning_page`, waiting for the add page)
- A config flow dialog cannot host a camera, an image picker or custom buttons, so the dialog
  shows only the device address and **Open commissioning page**
  (`/enocean-ble-scan?flow_id=<flow_id>`, a relative link: it opens inside the frontend and the
  HA app, not in a new window). A progress step has no Submit button; its task never completes
  by itself and is cancelled when the flow moves on or is removed.
- Input from the add page: `qr_code` is validated with `qr_onboarding.validate_qr_for_device()`;
  accepted → `show_progress_done` → `qr_add` (creates the entry); rejected → the same progress
  step with the error code in the `error` description placeholder.
  `button_sequence: true` → `show_progress_done` → `commissioning` (below).
- Other input keeps waiting.

### The add page

- Hidden, admin-only frontend panel (`panel.py`, `frontend/enocean-ble-scan-panel.js`),
  registered once. Scan QR code uses the HA app's native scanner (external bus `bar_code/scan`)
  or the browser camera; Select QR image the image picker. Camera frames and images are decoded with `BarcodeDetector`, else the decoder worker
  the HA frontend serves (`/static/js/qr-scanner-worker.min.js`). No third-party code is bundled.
- A flow continued from a discovery is not deleted when the dialog closes, so the page submits to
  `bluetooth_method` with the standard, authenticated config flow API
  (`POST /api/config/config_entries/flow/<flow_id>`): `{"qr_code": …}` or
  `{"button_sequence": true}`. It then follows the progress step (`data_entry_flow_progressed`
  events, polling as a fallback) and shows `bluetooth_confirm` or the `commissioning_retry`
  choice, all with the integration's translations (`config.error.<code>`, `config.step.*`).
- Opened without `flow_id`, the page lists the EnOcean BLE flows in progress to pick one.

Closing the dialog (X) restarts adding the switch: reopening a flow re-runs the current step
without input; `commissioning_retry` treats a second showing as reopened and returns to
`bluetooth_method` (`_reopened()`). A running `commissioning` progress step cannot be reset.

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
  `commissioning` = try again, `bluetooth_method` = back to the add form). A running progress step
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
