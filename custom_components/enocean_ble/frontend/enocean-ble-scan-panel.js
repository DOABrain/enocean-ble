/*
 * EnOcean BLE - scan page for the module label QR code.
 *
 * Hidden, admin-only Home Assistant panel: /enocean-ble-scan?flow_id=<flow_id>
 * (linked from the setup dialog of a discovered switch). Without a
 * flow_id it lists the discovered switches waiting to be added.
 *
 * Reading the code, in order of preference:
 *  1. Home Assistant app: its native scanner (external bus "bar_code/scan").
 *  2. Live camera, decoded with the browser BarcodeDetector API or, where that is
 *     missing (Safari, desktop Chrome on Windows), with the QR decoder the HA
 *     frontend already serves (/static/js/qr-scanner-worker.min.js, an ES module
 *     exporting createWorker()). No third-party code is bundled.
 *  3. A photo of the label (camera or gallery), decoded the same way.
 *  4. Pasting the text.
 *
 * The code is submitted to the config flow through the standard, authenticated
 * config flow API; all validation (format, address, key) happens in the flow and
 * its errors are shown with the integration's own translations. The page never
 * displays the security key.
 */

const DOMAIN = "enocean_ble";
// The flow's add step: a progress step (the dialog only links here) that takes
// qr_code or button_sequence; a rejected QR code comes back in placeholders.error.
const TEXT_STEP = "bluetooth_method";
const HA_QR_WORKER = "/static/js/qr-scanner-worker.min.js";
const QR_FORMAT_RE = /30S[0-9A-Fa-f]{12}.*\+Z[0-9A-Fa-f]{32}|E2:15(:[0-9A-Fa-f]{2}){4}[\s\S]*\b[0-9A-Fa-f]{32}\b/;

const STYLE = `
  :host { display: block; min-height: 100%; background: var(--primary-background-color);
    color: var(--primary-text-color); font-family: var(--ha-font-family-body, Roboto, sans-serif); }
  .toolbar { display: flex; align-items: center; gap: 8px; height: var(--header-height, 56px);
    padding: 0 12px; font-size: 20px; background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, var(--text-primary-color, #fff)); }
  .content { max-width: 560px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
  .card { background: var(--card-background-color, #fff); border-radius: var(--ha-card-border-radius, 12px);
    border: 1px solid var(--divider-color, #e0e0e0); padding: 16px; }
  h2 { margin: 0 0 4px; font-size: 18px; font-weight: 500; }
  p { margin: 0 0 12px; color: var(--secondary-text-color); line-height: 1.45; }
  .mac { font-family: monospace; }
  .actions { display: grid; gap: 8px; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 10px; padding: 12px 16px;
    background: var(--primary-color); color: var(--text-primary-color, #fff); text-align: center; }
  button.secondary { background: transparent; color: var(--primary-color); border: 1px solid var(--primary-color); }
  button:disabled { opacity: .5; cursor: default; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60px; padding: 8px; margin: 8px 0;
    font-family: monospace; font-size: 13px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .status { display: none; margin-top: 12px; padding: 10px 12px; border-radius: 8px; line-height: 1.4; }
  .status.info, .status.ok, .status.error { display: block; }
  .status.info { background: rgba(3, 169, 244, .12); }
  .status.ok { background: rgba(76, 175, 80, .15); }
  .status.error { background: rgba(219, 68, 55, .15); color: var(--error-color, #db4437); }
  ul { list-style: none; margin: 0; padding: 0; }
  li button { width: 100%; text-align: left; margin-bottom: 8px; }
  .facts { margin: 8px 0 16px; }
  .facts dt { font-size: 12px; color: var(--secondary-text-color); }
  .facts dd { margin: 0 0 8px; }
  #pasteBox textarea { margin-top: 0; }
  button.wide { width: 100%; }
  .notice { font-size: 13px; margin: 16px 0 8px; }
  .help { font-size: 13px; color: var(--secondary-text-color); }
  .help summary { cursor: pointer; color: var(--primary-color); }
  .help ul { list-style: disc; padding-left: 20px; margin: 8px 0 0; line-height: 1.5; }
  code { font-family: monospace; }
  a { color: var(--primary-color); }
  .overlay { position: fixed; inset: 0; z-index: 10; display: none; flex-direction: column;
    align-items: center; justify-content: center; background: #000; }
  .overlay.open { display: flex; }
  .overlay video { max-width: 100%; max-height: 75vh; }
  .overlay .bar { display: flex; gap: 12px; align-items: center; padding: 12px; color: #fff; }
`;

const errorMessage = (err) => (err && err.message) || String(err);

class EnOceanBleScanPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._root = null;
    this._flow = null;
    this._busy = false;
    this._stream = null;
    this._scanTimer = null;
    this._worker = null;
    this._workerJobs = new Map();
    this._workerSeq = 0;
    this._releaseNative = () => {};
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._menuButton) this._menuButton.hass = hass;
    if (first) this._start();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    if (this._menuButton) this._menuButton.narrow = narrow;
  }

  set panel(_panel) {}
  set route(_route) {}

  disconnectedCallback() {
    this._stopWatching();
    this._stopCamera();
    this._releaseNative();
    if (this._worker) this._worker.terminate();
    this._worker = null;
  }

  // ---------------------------------------------------------------- setup

  async _start() {
    this._render();
    try {
      await this._hass.loadBackendTranslation("config", DOMAIN);
    } catch (_err) {
      // Untranslated error codes are still shown.
    }
    const flowId = new URLSearchParams(window.location.search).get("flow_id");
    if (flowId) await this._openFlow(flowId);
    else await this._showPending();
  }

  _render() {
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = `
      <style>${STYLE}</style>
      <div class="toolbar"><span class="menu"></span><span>EnOcean BLE</span></div>
      <div class="content" id="content"></div>
      <div class="overlay" id="overlay">
        <video id="video" playsinline muted></video>
        <div class="bar"><span id="overlayMsg">Commissioning QR code: rear of the module</span>
          <button id="cancel" class="secondary">Cancel</button></div>
      </div>`;
    if (customElements.get("ha-menu-button")) {
      this._menuButton = document.createElement("ha-menu-button");
      this._menuButton.hass = this._hass;
      this._menuButton.narrow = this._narrow;
      this._root.querySelector(".menu").appendChild(this._menuButton);
    }
    this._el("cancel").addEventListener("click", () => this._stopCamera());
  }

  _el(id) {
    return this._root.getElementById(id);
  }

  _content(html) {
    const content = this._el("content");
    content.innerHTML = html;
    return content;
  }

  _localizeError(code) {
    const text = this._hass.localize(`component.${DOMAIN}.config.error.${code}`);
    return text || code;
  }

  // ---------------------------------------------------------------- flows

  async _showPending() {
    let flows = [];
    try {
      flows = (await this._hass.callWS({ type: "config_entries/flow/progress" })).filter(
        (flow) => flow.handler === DOMAIN
      );
    } catch (err) {
      this._content(`<div class="card"><p>${errorMessage(err)}</p></div>`);
      return;
    }
    const content = this._content(`
      <div class="card">
        <h2>Add an EnOcean switch</h2>
        <p>Discovered devices awaiting commissioning. A device is listed once a telegram from it is received.</p>
        <ul id="flows"></ul>
      </div>`);
    const list = content.querySelector("#flows");
    if (!flows.length) {
      const li = document.createElement("li");
      li.textContent = "No discovered devices awaiting commissioning.";
      list.appendChild(li);
      return;
    }
    for (const flow of flows) {
      const name = (flow.context && flow.context.title_placeholders && flow.context.title_placeholders.name) || flow.flow_id;
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = name;
      button.addEventListener("click", () => {
        history.replaceState(null, "", `${window.location.pathname}?flow_id=${encodeURIComponent(flow.flow_id)}`);
        this._openFlow(flow.flow_id);
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  _flowUrl() {
    return `config/config_entries/flow/${this._flowId}`;
  }

  async _openFlow(flowId) {
    this._flowId = flowId;
    try {
      await this._handleStep(await this._hass.callApi("GET", this._flowUrl()));
    } catch (_err) {
      this._showGone();
    }
  }

  _showGone() {
    this._stopWatching();
    this._content(`
      <div class="card"><h2>Nothing to add</h2>
        <p>This device is no longer awaiting commissioning (already added, or the setup was closed).</p>
        <p><a href="/enocean-ble-scan">Discovered devices</a></p></div>`);
  }

  // Show the view for wherever the config flow is. The page drives the same flow as the
  // setup dialog: bluetooth_method (qr_code / button_sequence), commissioning (progress),
  // bluetooth_confirm, commissioning_retry, create_entry.
  async _handleStep(step) {
    if (step.handler && step.handler !== DOMAIN) {
      this._showGone();
      return;
    }
    if (step.type === "create_entry") {
      this._stopWatching();
      this._showDone(step);
      return;
    }
    if (step.type === "abort") {
      this._stopWatching();
      this._content(`<div class="card"><h2>Not added</h2><p id="reason"></p>
        <p><a href="/enocean-ble-scan">Discovered devices</a></p></div>`);
      this._el("reason").textContent =
        this._hass.localize(`component.${DOMAIN}.config.abort.${step.reason}`) || step.reason;
      return;
    }
    if (step.description_placeholders) this._placeholders = step.description_placeholders;
    if (step.type === "progress" && step.step_id === TEXT_STEP) {
      this._stopWatching();
      this._flow = step;
      this._showMethods();
      return;
    }
    if (step.type === "progress") {
      this._showWaiting();
      this._watch();
      return;
    }
    if (step.type === "form" && step.step_id === "bluetooth_confirm") {
      this._stopWatching();
      this._showConfirm();
      return;
    }
    if (step.type === "menu" && step.step_id === "commissioning_retry") {
      this._stopWatching();
      this._showRetry();
      return;
    }
    this._showGone();
  }

  _showMethods() {
    const ph = this._placeholders || {};
    const content = this._content(`
      <div class="card">
        <h2 id="name"></h2>
        <dl class="facts">
          <dt>Device address</dt><dd class="mac" id="mac"></dd>
          <dt>Commissioning QR code</dt><dd>Located on the rear of the module.</dd>
        </dl>
        <div class="actions">
          <button id="scan" class="secondary">Scan QR code</button>
          <button id="photo" class="secondary">Select QR image</button>
          <input id="file" type="file" accept="image/*" capture="environment" hidden>
          <button id="paste" class="secondary" aria-expanded="false" aria-controls="pasteBox">Paste QR data</button>
          <div id="pasteBox" hidden>
            <textarea id="text" autocomplete="off" autocapitalize="off" spellcheck="false"
              placeholder="30SE215…+Z…+30P…" aria-label="QR data"></textarea>
            <button id="add" class="wide">Submit QR data</button>
          </div>
          <button id="commission" class="secondary">Manual commissioning (button sequence)</button>
        </div>
        <div id="status" class="status"></div>
        <p class="notice">Some OEM modules are restricted to manufacturer-specific commissioning methods.
          Manual and/or QR commissioning may be unavailable depending on the module and firmware.</p>
        <details class="help">
          <summary>Help</summary>
          <ul>
            <li>The QR label is on the rear of the PTM 215B/216B module. Access requires removing the
              rocker; on some frames the module must be removed as well.</li>
            <li>QR data format: <code>30S&lt;address&gt;+Z&lt;32-digit key&gt;+30P…</code></li>
            <li>Manual commissioning: hold button 1 for 7 s, press briefly, hold again for 7 s.
              Telegram timeout: 2 min.</li>
            <li>Live camera scanning in a browser requires HTTPS. Image selection and pasting do not.</li>
          </ul>
        </details>
      </div>`);
    content.querySelector("#name").textContent = `Add ${ph.name || "EnOcean switch"}`;
    content.querySelector("#mac").textContent = ph.mac || "";
    content.querySelector("#scan").addEventListener("click", () => this._scan());
    content.querySelector("#photo").addEventListener("click", () => content.querySelector("#file").click());
    content.querySelector("#file").addEventListener("change", (ev) => this._scanPhoto(ev));
    content.querySelector("#paste").addEventListener("click", () => this._openPaste(!content.querySelector("#pasteBox").hidden));
    content.querySelector("#add").addEventListener("click", () => this._submit(content.querySelector("#text").value));
    content.querySelector("#commission").addEventListener("click", () => this._startCommissioning());
  }

  _openPaste(close = false) {
    const box = this._el("pasteBox");
    if (!box) return;
    box.hidden = close;
    this._el("paste").setAttribute("aria-expanded", String(!close));
    if (!close) this._el("text").focus();
  }

  // ---------------------------------------------------------------- manual commissioning

  _localizeStep(key, fallback) {
    const ph = this._placeholders || {};
    const text = this._hass.localize(`component.${DOMAIN}.config.${key}`, ph);
    return text || fallback;
  }

  async _startCommissioning() {
    if (this._busy) return;
    this._busy = true;
    try {
      await this._handleStep(
        await this._hass.callApi("POST", this._flowUrl(), { button_sequence: true })
      );
    } catch (err) {
      this._status("error", `Manual commissioning could not be started: ${errorMessage(err)}`);
    } finally {
      this._busy = false;
    }
  }

  _showWaiting() {
    const content = this._content(`
      <div class="card">
        <h2>Manual commissioning</h2>
        <p id="steps"></p>
        <div class="status info">Waiting for the commissioning telegram (timeout 2 min)…</div>
      </div>`);
    content.querySelector("#steps").innerText = this._localizeStep(
      "step.commissioning.description",
      "Commissioning sequence: hold button 1 for 7 s, press briefly, hold again for 7 s. Timeout: 2 min."
    );
  }

  _watch() {
    if (this._unsubProgress || this._pollTimer) return;
    const refresh = async () => {
      try {
        const step = await this._hass.callApi("GET", this._flowUrl());
        if (step.type !== "progress") await this._handleStep(step);
      } catch (_err) {
        this._showGone();
      }
    };
    this._hass.connection
      .subscribeEvents((ev) => {
        if (ev.data && ev.data.flow_id === this._flowId) refresh();
      }, "data_entry_flow_progressed")
      .then((unsub) => {
        if (this._pollTimer) this._unsubProgress = unsub;
        else unsub();
      })
      .catch(() => {});
    // Fallback in case an event is missed.
    this._pollTimer = setInterval(refresh, 5000);
  }

  _stopWatching() {
    if (this._unsubProgress) this._unsubProgress();
    this._unsubProgress = null;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  _showConfirm() {
    const content = this._content(`
      <div class="card">
        <h2 id="title"></h2>
        <p id="text"></p>
        <button id="confirm">Submit</button>
        <div id="status" class="status"></div>
      </div>`);
    content.querySelector("#title").textContent = this._localizeStep(
      "step.bluetooth_confirm.title", "Commissioning telegram received");
    content.querySelector("#text").innerText = this._localizeStep(
      "step.bluetooth_confirm.description",
      "Device commissioned. Press another button to exit commissioning mode, then submit."
    );
    content.querySelector("#confirm").addEventListener("click", async () => {
      try {
        await this._handleStep(await this._hass.callApi("POST", this._flowUrl(), {}));
      } catch (err) {
        this._status("error", `Device could not be added: ${errorMessage(err)}`);
      }
    });
  }

  _showRetry() {
    const content = this._content(`
      <div class="card">
        <h2 id="title"></h2>
        <p id="text"></p>
        <div class="actions">
          <button id="retry"></button>
          <button id="back" class="secondary"></button>
        </div>
      </div>`);
    content.querySelector("#title").textContent = this._localizeStep(
      "step.commissioning_retry.title", "Commissioning failed");
    content.querySelector("#text").innerText = this._localizeStep(
      "step.commissioning_retry.description", "No valid commissioning telegram was received.");
    content.querySelector("#retry").textContent = this._localizeStep(
      "step.commissioning_retry.menu_options.commissioning", "Retry");
    content.querySelector("#back").textContent = this._localizeStep(
      "step.commissioning_retry.menu_options.bluetooth_method", "Commissioning methods");
    const choose = async (next) => {
      try {
        await this._handleStep(await this._hass.callApi("POST", this._flowUrl(), { next_step_id: next }));
      } catch (_err) {
        this._showGone();
      }
    };
    content.querySelector("#retry").addEventListener("click", () => choose("commissioning"));
    content.querySelector("#back").addEventListener("click", () => choose("bluetooth_method"));
  }

  _status(kind, message) {
    const el = this._el("status");
    if (!el) return;
    el.className = `status ${kind}`;
    el.textContent = message;
  }

  async _submit(raw) {
    const text = String(raw || "").trim();
    if (!text || this._busy || !this._flowId) return;
    this._busy = true;
    this._status("info", "Validating QR data…");
    try {
      const result = await this._hass.callApi("POST", this._flowUrl(), { qr_code: text });
      if (result.type !== "progress" || result.step_id !== TEXT_STEP) {
        await this._handleStep(result);
        return;
      }
      this._flow = result;
      const code = (result.description_placeholders && result.description_placeholders.error) || "invalid_qr";
      this._status("error", this._localizeError(code));
    } catch (err) {
      this._status("error", `Device could not be added: ${errorMessage(err)}`);
    } finally {
      this._busy = false;
    }
  }

  _showDone(result) {
    const content = this._content(`
      <div class="card">
        <h2>Device added</h2>
        <p><span id="title"></span> added.</p>
        <p><a href="/config/integrations/integration/${DOMAIN}">Open EnOcean BLE</a> ·
          <a href="/enocean-ble-scan">Discovered devices</a></p>
      </div>`);
    content.querySelector("#title").textContent = result.title || "The switch";
  }

  // ---------------------------------------------------------------- reading

  _external() {
    const ext = this._hass && this._hass.auth && this._hass.auth.external;
    return ext && ext.config && ext.config.hasBarCodeScanner && typeof ext.fireMessage === "function"
      && "_commandHandler" in ext ? ext : null;
  }

  _scan() {
    if (this._external()) this._scanNative();
    else this._scanCamera();
  }

  // HA app: its native scanner. The frontend has no public hook for scan results in
  // custom panels, so the external bus command handler is wrapped while scanning and
  // always passed through to the original handler.
  _scanNative() {
    const ext = this._external();
    const original = ext._commandHandler;
    const wrapped = (msg) => {
      if (msg && msg.type === "command" && msg.command === "bar_code/scan_result") {
        const value = (msg.payload && msg.payload.rawValue) || "";
        if (QR_FORMAT_RE.test(value)) {
          this._releaseNative();
          ext.fireMessage({ type: "bar_code/close" });
          this._submit(value);
        } else {
          ext.fireMessage({
            type: "bar_code/notify",
            payload: { message: "Not an EnOcean commissioning QR code." },
          });
        }
      } else if (msg && msg.type === "command" && msg.command === "bar_code/aborted") {
        this._releaseNative();
        if (msg.payload && msg.payload.reason === "alternative_options") this._openPaste();
      }
      return typeof original === "function" ? original.call(ext, msg) : true;
    };
    this._releaseNative = () => {
      if (ext._commandHandler === wrapped) ext._commandHandler = original;
      this._releaseNative = () => {};
    };
    ext._commandHandler = wrapped;
    ext.fireMessage({
      type: "bar_code/scan",
      payload: {
        title: "Scan commissioning QR code",
        description: "Commissioning QR code: rear of the module.",
        alternative_option_label: "Paste QR data",
      },
    });
  }

  async _scanCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._status("error", "Live camera unavailable: HTTPS required. Use Select QR image or Paste QR data.");
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      this._status("error", `Camera unavailable: ${errorMessage(err)}. Use Select QR image or Paste QR data.`);
      return;
    }
    const video = this._el("video");
    const msg = this._el("overlayMsg");
    msg.textContent = "Commissioning QR code: rear of the module";
    this._el("overlay").classList.add("open");
    video.srcObject = this._stream;
    await video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const tick = async () => {
      if (!this._stream) return;
      try {
        if (video.videoWidth) {
          const value = await this._decode(video, canvas);
          if (value && QR_FORMAT_RE.test(value)) {
            this._stopCamera();
            this._submit(value);
            return;
          }
          if (value) msg.textContent = "Not an EnOcean commissioning QR code";
        }
      } catch (_err) {
        // keep scanning
      }
      this._scanTimer = setTimeout(tick, 250);
    };
    tick();
  }

  _stopCamera() {
    clearTimeout(this._scanTimer);
    this._scanTimer = null;
    if (this._stream) {
      this._stream.getTracks().forEach((track) => track.stop());
      this._stream = null;
    }
    if (this._root) {
      this._el("video").srcObject = null;
      this._el("overlay").classList.remove("open");
    }
  }

  async _scanPhoto(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    this._status("info", "Decoding image…");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      let value = null;
      // The label can be small or large in the photo: try a few sizes.
      for (const maxSide of [1600, 1024, 2400]) {
        value = await this._decode(bitmap, canvas, maxSide);
        if (value || this._detector) break;
      }
      if (value && QR_FORMAT_RE.test(value)) this._submit(value);
      else this._status("error", "No EnOcean commissioning QR code detected in the image.");
    } catch (err) {
      this._status("error", `Image could not be decoded: ${errorMessage(err)}`);
    }
  }

  // Decode a video frame or image: BarcodeDetector if it supports QR, else HA's worker.
  async _decode(source, canvas, maxSide = 1024) {
    if (await this._hasDetector()) {
      const codes = await this._detector.detect(source);
      return codes.length ? codes[0].rawValue : null;
    }
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return this._workerDecode(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  async _hasDetector() {
    if (this._detectorChecked) return Boolean(this._detector);
    this._detectorChecked = true;
    try {
      if ("BarcodeDetector" in window && (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
        this._detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch (_err) {
      this._detector = null;
    }
    return Boolean(this._detector);
  }

  // HA's qr-scanner worker file is an ES module exporting createWorker(); the worker it
  // returns takes {id, type: "decode", data: ImageData} and answers {id, type: "qrResult", data}.
  async _workerDecode(imageData) {
    if (!this._worker) {
      const module = await import(HA_QR_WORKER);
      this._worker = module.createWorker();
      this._worker.onmessage = (ev) => {
        const job = this._workerJobs.get(ev.data && ev.data.id);
        if (!job || ev.data.type !== "qrResult") return;
        this._workerJobs.delete(ev.data.id);
        job(ev.data.data || null);
      };
    }
    const id = ++this._workerSeq;
    return new Promise((resolve) => {
      this._workerJobs.set(id, resolve);
      this._worker.postMessage({ id, type: "decode", data: imageData }, [imageData.data.buffer]);
      setTimeout(() => {
        if (this._workerJobs.delete(id)) resolve(null);
      }, 8000);
    });
  }
}

if (!customElements.get("enocean-ble-scan-panel")) {
  customElements.define("enocean-ble-scan-panel", EnOceanBleScanPanel);
}
