/*
 * EnOcean BLE - scan page for the module label QR code.
 *
 * Hidden, admin-only Home Assistant panel: /enocean-ble-scan?flow_id=<flow_id>
 * (linked from the "Scan the QR code" step of a discovered switch). Without a
 * flow_id it lists the discovered switches waiting to be added.
 *
 * Reading the code, in order of preference:
 *  1. Home Assistant app: its native scanner (external bus "bar_code/scan").
 *  2. Live camera, decoded with the browser BarcodeDetector API or, where that is
 *     missing (Safari), with the QR decoder worker the HA frontend already serves
 *     (/static/js/qr-scanner-worker.min.js). No third-party code is bundled.
 *  3. A photo of the label (camera or gallery), decoded the same way.
 *  4. Pasting the text.
 *
 * The code is submitted to the config flow through the standard, authenticated
 * config flow API; all validation (format, address, key) happens in the flow and
 * its errors are shown with the integration's own translations. The page never
 * displays the security key.
 */

const DOMAIN = "enocean_ble";
const SCAN_STEPS = ["qr_scan", "qr_text"];
const MENU_STEP = "bluetooth_method";
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
        <div class="bar"><span id="overlayMsg">Aim at the QR code on the module label</span>
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
        <h2>Discovered EnOcean switches</h2>
        <p>Pick the switch whose label you want to scan. A switch appears here after you press
          one of its buttons.</p>
        <ul id="flows"></ul>
      </div>`);
    const list = content.querySelector("#flows");
    if (!flows.length) {
      const li = document.createElement("li");
      li.textContent = "No discovered switch is waiting. Press a button on the switch, then reload this page.";
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

  async _openFlow(flowId) {
    let step;
    try {
      step = await this._hass.callApi("GET", `config/config_entries/flow/${flowId}`);
      if (step.type === "menu" && step.step_id === MENU_STEP) {
        step = await this._hass.callApi("POST", `config/config_entries/flow/${flowId}`, {
          next_step_id: "qr_scan",
        });
      }
    } catch (_err) {
      this._content(`
        <div class="card"><h2>Nothing to scan</h2>
          <p>This switch is no longer waiting to be added (already added, or the setup was closed).</p>
          <p><a href="/${"enocean-ble-scan"}">Show discovered switches</a></p></div>`);
      return;
    }
    if (step.handler !== DOMAIN || step.type !== "form" || !SCAN_STEPS.includes(step.step_id)) {
      this._content(`<div class="card"><p>This setup is not waiting for a QR code.</p></div>`);
      return;
    }
    this._flow = step;
    this._showScan();
  }

  _showScan() {
    const ph = this._flow.description_placeholders || {};
    const content = this._content(`
      <div class="card">
        <h2 id="name"></h2>
        <p>Remove the rocker and scan the QR code on the EnOcean module label. Its address must be
          <span class="mac" id="mac"></span>.</p>
        <div class="actions">
          <button id="scan">Scan with the camera</button>
          <button id="photo" class="secondary">Take or choose a photo</button>
          <input id="file" type="file" accept="image/*" capture="environment" hidden>
        </div>
        <div id="status" class="status"></div>
      </div>
      <div class="card">
        <h2>Or paste the QR code text</h2>
        <textarea id="text" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="30SE215…+Z…+30P…"></textarea>
        <button id="add">Add switch</button>
      </div>`);
    content.querySelector("#name").textContent = ph.name || "EnOcean switch";
    content.querySelector("#mac").textContent = ph.mac || "";
    content.querySelector("#scan").addEventListener("click", () => this._scan());
    content.querySelector("#photo").addEventListener("click", () => content.querySelector("#file").click());
    content.querySelector("#file").addEventListener("change", (ev) => this._scanPhoto(ev));
    content.querySelector("#add").addEventListener("click", () => this._submit(content.querySelector("#text").value));
  }

  _status(kind, message) {
    const el = this._el("status");
    if (!el) return;
    el.className = `status ${kind}`;
    el.textContent = message;
  }

  async _submit(raw) {
    const text = String(raw || "").trim();
    if (!text || this._busy || !this._flow) return;
    this._busy = true;
    this._status("info", "Checking the QR code…");
    try {
      const result = await this._hass.callApi("POST", `config/config_entries/flow/${this._flow.flow_id}`, {
        qr_code: text,
      });
      if (result.type === "create_entry") {
        this._showDone(result);
        return;
      }
      if (result.type === "abort") {
        this._status("error", this._hass.localize(`component.${DOMAIN}.config.abort.${result.reason}`) || result.reason);
        return;
      }
      this._flow = result;
      const code = (result.errors && result.errors.base) || "invalid_qr";
      this._status("error", this._localizeError(code));
    } catch (err) {
      this._status("error", `Could not add the switch: ${errorMessage(err)}`);
    } finally {
      this._busy = false;
    }
  }

  _showDone(result) {
    const content = this._content(`
      <div class="card">
        <h2>Switch added</h2>
        <p><span id="title"></span> has been added. Press one of its buttons to test it.</p>
        <p><a href="/config/integrations/integration/${DOMAIN}">Open EnOcean BLE</a> ·
          <a href="/enocean-ble-scan">Add another switch</a></p>
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
            payload: { message: "This is not an EnOcean module QR code." },
          });
        }
      } else if (msg && msg.type === "command" && msg.command === "bar_code/aborted") {
        this._releaseNative();
        if (msg.payload && msg.payload.reason === "alternative_options") this._el("text").focus();
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
        title: "Scan EnOcean switch",
        description: "Aim at the QR code on the module label, behind the rocker.",
        alternative_option_label: "Enter the text instead",
      },
    });
  }

  async _scanCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._status("error", "No camera access here (it needs HTTPS). Take a photo or paste the text instead.");
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      this._status("error", `Camera not available: ${errorMessage(err)}. Take a photo or paste the text instead.`);
      return;
    }
    const video = this._el("video");
    const msg = this._el("overlayMsg");
    msg.textContent = "Aim at the QR code on the module label";
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
          if (value) msg.textContent = "That is not an EnOcean module QR code";
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
    this._status("info", "Reading the photo…");
    try {
      const bitmap = await createImageBitmap(file);
      const value = await this._decode(bitmap, document.createElement("canvas"), 1600);
      if (value && QR_FORMAT_RE.test(value)) this._submit(value);
      else this._status("error", "No EnOcean module QR code found in this photo. Try again closer, without glare.");
    } catch (err) {
      this._status("error", `Could not read the photo: ${errorMessage(err)}`);
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

  _workerDecode(imageData) {
    if (!this._worker) {
      this._worker = new Worker(HA_QR_WORKER);
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
      }, 3000);
    });
  }
}

if (!customElements.get("enocean-ble-scan-panel")) {
  customElements.define("enocean-ble-scan-panel", EnOceanBleScanPanel);
}
