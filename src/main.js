// Tauri API is injected globally via withGlobalTauri in tauri.conf.json
const invoke = globalThis.__TAURI__.core.invoke;

// On Windows (decorations: false), outer = inner + (16, 9). Used so dev size display
// matches tauri.conf.json (inner size). Non-Windows uses 0 so display = outer.
const OUTER_FRAME_W = 16;
const OUTER_FRAME_H = 9;

// ============ State ============
let isConnected = false;
let config = null;
let shortcutEnabled = false;
let currentShortcut = "";
let isRecordingShortcut = false;
let recordedKeys = new Set();

// Action shortcuts: id -> { shortcut, global }. shortcutToAction maps shortcut string -> id for keydown.
let actionShortcuts = {};
let shortcutToAction = {};
let isRecordingActionShortcut = null; // action id when recording, else null

const ACTIONS = [
  { id: "up", label: "Up", defaultShortcut: "Up" },
  { id: "down", label: "Down", defaultShortcut: "Down" },
  { id: "left", label: "Left", defaultShortcut: "Left" },
  { id: "right", label: "Right", defaultShortcut: "Right" },
  { id: "enter", label: "OK / Enter", defaultShortcut: "Return" },
  { id: "back", label: "Back", defaultShortcut: "Backspace" },
  { id: "rewind", label: "Rewind", defaultShortcut: "[" },
  { id: "play", label: "Play", defaultShortcut: "Space" },
  { id: "pause", label: "Pause", defaultShortcut: "P" },
  { id: "stop", label: "Stop", defaultShortcut: "S" },
  { id: "fast_forward", label: "Fast Forward", defaultShortcut: "]" },
  { id: "volume_up", label: "Volume Up", defaultShortcut: "=" },
  { id: "volume_down", label: "Volume Down", defaultShortcut: "-" },
  { id: "mute", label: "Mute", defaultShortcut: "Shift+-" },
  { id: "unmute", label: "Unmute", defaultShortcut: "Shift+=" },
  { id: "power_on", label: "Power On", defaultShortcut: "F7" },
  { id: "power_off", label: "Power Off", defaultShortcut: "F8" },
  { id: "home", label: "Home", defaultShortcut: "Home" },
  {
    id: "wake_streaming_device",
    label: "Wake streaming device",
    defaultShortcut: "",
  },
];

// ============ UI Helpers ============

function hasConnectionInfo() {
  return Boolean(
    config?.active_tv && config.tvs?.[config.active_tv]?.client_key,
  );
}

function setStatus(connected, text) {
  isConnected = connected;
  const dot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const connectBtn = document.getElementById("status-connect-btn");

  dot.className = `dot ${connected ? "connected" : "disconnected"}`;
  if (connected) {
    statusText.textContent = text || "Connected";
    statusText.style.display = "";
    connectBtn.style.display = "none";
    refreshConnectedUi();
  } else if (hasConnectionInfo()) {
    statusText.style.display = "none";
    connectBtn.style.display = "";
    resetConnectedUi();
  } else {
    statusText.textContent = text || "Not Connected";
    statusText.style.display = "";
    connectBtn.style.display = "none";
    resetConnectedUi();
  }
}

function setConnecting() {
  const dot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const connectBtn = document.getElementById("status-connect-btn");

  dot.className = "dot connecting";
  statusText.textContent = "Connecting...";
  statusText.style.display = "";
  connectBtn.style.display = "none";
}

function showToast(message, type = "info") {
  // Remove existing toast
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Show
  setTimeout(() => toast.classList.add("show"), 10);

  // Hide after delay
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function toggleSettings() {
  const panel = document.getElementById("settings-panel");
  panel.classList.toggle("collapsed");
}

function toggleShortcuts() {
  const panel = document.getElementById("shortcuts-panel");
  panel.classList.toggle("collapsed");
}

function toggleApps() {
  const panel = document.getElementById("apps-panel");
  const wasCollapsed = panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed");
  if (wasCollapsed && isConnected) {
    refreshApps();
  }
}

function buttonFeedback(element) {
  element.classList.add("active");
  setTimeout(() => element.classList.remove("active"), 100);
}

// ============ TV Commands ============

// Check if error indicates we are no longer connected (single source of truth for UI)
function isDisconnectError(error) {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("disconnected") ||
    msg.includes("not connected") ||
    msg.includes("connection closed") ||
    msg.includes("timeout") ||
    msg.includes("send failed") ||
    msg.includes("websocket error")
  );
}

// Handle command errors - update status if disconnected
function handleCommandError(e) {
  showToast(e, "error");
  if (isDisconnectError(e)) {
    setStatus(false, "Disconnected");
  }
}

async function sendButton(button) {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("send_button", { button });
  } catch (e) {
    handleCommandError(e);
  }
}

let volumeSliderDragging = false;

function applyVolumeUi(volume, muted) {
  const slider = document.getElementById("volume-slider");
  const label = document.getElementById("volume-label");
  if (!slider || !label) return;

  const level = Math.max(0, Math.min(100, Number(volume) || 0));
  if (!volumeSliderDragging) {
    slider.value = String(level);
  }
  slider.disabled = !isConnected;
  label.textContent = muted ? "M" : String(level);
  label.title = muted ? `Muted (${level})` : `Volume ${level}`;
}

function onVolumeSliderInput(value) {
  volumeSliderDragging = true;
  const label = document.getElementById("volume-label");
  if (label) {
    label.textContent = String(value);
    label.title = `Volume ${value}`;
  }
}

async function refreshVolume() {
  if (!isConnected) return;
  try {
    const result = await invoke("get_volume");
    const payload = result?.payload || {};
    applyVolumeUi(payload.volume, payload.muted);
  } catch (e) {
    handleCommandError(e);
  }
}

async function setVolumeLevel(value) {
  volumeSliderDragging = false;
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  const level = Math.max(0, Math.min(100, Number.parseInt(value, 10) || 0));
  try {
    await invoke("set_volume", { level });
    applyVolumeUi(level, false);
  } catch (e) {
    handleCommandError(e);
    refreshVolume();
  }
}

async function volumeUp() {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("volume_up");
    await refreshVolume();
  } catch (e) {
    handleCommandError(e);
  }
}

async function volumeDown() {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("volume_down");
    await refreshVolume();
  } catch (e) {
    handleCommandError(e);
  }
}

async function setMute(mute) {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("set_mute", { mute });
    showToast(mute ? "Muted" : "Unmuted", "success");
    await refreshVolume();
  } catch (e) {
    handleCommandError(e);
  }
}

function resetConnectedUi() {
  volumeSliderDragging = false;
  const slider = document.getElementById("volume-slider");
  const label = document.getElementById("volume-label");
  if (slider) {
    slider.disabled = true;
    slider.value = "0";
  }
  if (label) {
    label.textContent = "—";
    label.title = "Volume";
  }

  const inputsList = document.getElementById("inputs-list");
  if (inputsList) {
    inputsList.innerHTML = `<span class="hint">Connect to load inputs</span>`;
  }

  const appsList = document.getElementById("apps-list");
  if (appsList) {
    appsList.innerHTML = `<span class="hint">Connect to load apps</span>`;
  }
}

function refreshConnectedUi() {
  refreshVolume();
  refreshInputs();
  const appsPanel = document.getElementById("apps-panel");
  if (appsPanel && !appsPanel.classList.contains("collapsed")) {
    refreshApps();
  }
}

function inputLabel(device) {
  return device.label || device.appId || device.id || device.port || "Input";
}

async function refreshInputs() {
  const list = document.getElementById("inputs-list");
  if (!list) return;
  if (!isConnected) {
    list.innerHTML = `<span class="hint">Connect to load inputs</span>`;
    return;
  }

  list.innerHTML = `<span class="hint">Loading…</span>`;
  try {
    const result = await invoke("list_inputs");
    const devices = result?.payload?.devices || [];
    if (!devices.length) {
      list.innerHTML = `<span class="hint">No inputs found</span>`;
      return;
    }

    list.innerHTML = "";
    for (const device of devices) {
      if (!device?.id) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      if (device.connected) btn.classList.add("connected-input");
      btn.textContent = inputLabel(device);
      btn.title = device.id;
      btn.addEventListener("click", () =>
        switchInput(device.id, inputLabel(device)),
      );
      list.appendChild(btn);
    }
    if (!list.children.length) {
      list.innerHTML = `<span class="hint">No inputs found</span>`;
    }
  } catch (e) {
    list.innerHTML = `<span class="hint">Could not load inputs</span>`;
    handleCommandError(e);
  }
}

async function switchInput(inputId, label) {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("switch_input", { inputId });
    showToast(`Switched to ${label || inputId}`, "success");
  } catch (e) {
    handleCommandError(e);
  }
}

const PRIORITY_APP_IDS = [
  "netflix",
  "youtube.leanback.v4",
  "youtube.leanback.kids.v4",
  "com.webos.app.hdmi1",
  "com.webos.app.hdmi2",
  "com.webos.app.hdmi3",
  "com.webos.app.hdmi4",
  "amazon",
  "com.disney.disneyplus-prod",
  "com.hulu.livingroomplus",
  "com.apple.app.tv",
  "com.spotify.spotify.tv",
  "plex",
];

function appSortKey(app) {
  const id = String(app.id || "").toLowerCase();
  const priority = PRIORITY_APP_IDS.findIndex(
    (p) => id === p || id.includes(p),
  );
  return priority === -1 ? 1000 : priority;
}

async function refreshApps() {
  const list = document.getElementById("apps-list");
  if (!list) return;
  if (!isConnected) {
    list.innerHTML = `<span class="hint">Connect to load apps</span>`;
    return;
  }

  list.innerHTML = `<span class="hint">Loading…</span>`;
  try {
    const result = await invoke("list_launch_points");
    const launchPoints = (result?.payload?.launchPoints || [])
      .filter((app) => app?.id && String(app.title || "").trim())
      .sort((a, b) => {
        const byPriority = appSortKey(a) - appSortKey(b);
        if (byPriority !== 0) return byPriority;
        return String(a.title).localeCompare(String(b.title));
      });

    if (!launchPoints.length) {
      list.innerHTML = `<span class="hint">No apps found</span>`;
      return;
    }

    list.innerHTML = "";
    for (const app of launchPoints) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "app-btn";
      btn.textContent = app.title;
      btn.title = app.id;
      btn.addEventListener("click", () => launchApp(app.id, app.title));
      list.appendChild(btn);
    }
  } catch (e) {
    list.innerHTML = `<span class="hint">Could not load apps</span>`;
    handleCommandError(e);
  }
}

async function launchApp(appId, title) {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("launch_app", { appId });
    showToast(`Launched ${title || appId}`, "success");
  } catch (e) {
    handleCommandError(e);
  }
}

const POWER_ON_RECONNECT_INTERVAL_MS = 1000;
const POWER_ON_RECONNECT_MAX_TRIES = 10;

async function powerOn() {
  try {
    const result = await invoke("power_on");
    showToast(result.message || "Wake-on-LAN sent. Connecting...", "success");
    // Try to connect every 1s, up to 10 times
    let tries = 0;
    const tryConnect = async () => {
      tries += 1;
      setConnecting();
      try {
        await invoke("connect");
        setStatus(true, "Connected");
        showToast("Connected to TV", "success");
        return;
      } catch {
        if (tries < POWER_ON_RECONNECT_MAX_TRIES) {
          setTimeout(tryConnect, POWER_ON_RECONNECT_INTERVAL_MS);
        } else {
          setStatus(false);
          showToast("TV did not respond after 10 tries", "error");
        }
      }
    };
    setTimeout(tryConnect, POWER_ON_RECONNECT_INTERVAL_MS);
  } catch (e) {
    showToast(e, "error");
  }
}

async function powerOff() {
  if (!isConnected) {
    showToast("Not connected", "error");
    return;
  }

  try {
    await invoke("power_off");
    setStatus(false, "TV Off");
    showToast("TV powered off", "success");
  } catch (e) {
    handleCommandError(e);
  }
}

async function fetchMac() {
  if (!isConnected) {
    showToast("Connect to TV first", "error");
    return;
  }

  try {
    const result = await invoke("fetch_mac");
    showToast(result.message || "MAC address fetched", "success");
    // Reload config to update the MAC display
    await loadConfig();
  } catch (e) {
    handleCommandError(e);
  }
}

const STREAMING_DEVICE_TYPE_LABELS = {
  "": "None",
  wol: "Wake-on-LAN (Android TV / Shield)",
  adb: "ADB (Android TV / Shield)",
  roku: "Roku",
};

function setStreamingDeviceType(value) {
  const input = document.getElementById("streaming-device-type");
  const button = document.getElementById("streaming-device-type-button");
  input.value = value;
  if (button) {
    button.textContent = STREAMING_DEVICE_TYPE_LABELS[value] ?? "None";
  }
  const menu = document.getElementById("streaming-device-type-menu");
  if (!menu) return;
  for (const option of menu.querySelectorAll("[data-value]")) {
    option.setAttribute(
      "aria-selected",
      option.dataset.value === value ? "true" : "false",
    );
  }
}

function positionStreamingDeviceMenu() {
  const button = document.getElementById("streaming-device-type-button");
  const menu = document.getElementById("streaming-device-type-menu");
  if (!button || !menu || menu.hidden) return;
  const rect = button.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const gap = 2;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const openUp = spaceBelow < menuHeight && rect.top > spaceBelow;
  const top = openUp
    ? Math.max(8, rect.top - menuHeight - gap)
    : rect.bottom + gap;
  menu.style.top = `${top}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;
}

function closeStreamingDeviceMenu() {
  const menu = document.getElementById("streaming-device-type-menu");
  const button = document.getElementById("streaming-device-type-button");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  button?.setAttribute("aria-expanded", "false");
}

function setupStreamingDeviceTypePicker() {
  const picker = document.getElementById("streaming-device-type-picker");
  const button = document.getElementById("streaming-device-type-button");
  const menu = document.getElementById("streaming-device-type-menu");
  if (!picker || !button || !menu) return;

  // Leave the overflow:hidden settings panel so the list is not clipped.
  document.body.appendChild(menu);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) positionStreamingDeviceMenu();
  });

  menu.addEventListener("click", async (e) => {
    const option = e.target.closest("[data-value]");
    if (!option) return;
    e.stopPropagation();
    setStreamingDeviceType(option.dataset.value);
    closeStreamingDeviceMenu();
    await onStreamingDeviceTypeChange();
  });

  document.addEventListener("click", (e) => {
    if (!picker.contains(e.target) && !menu.contains(e.target)) {
      closeStreamingDeviceMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeStreamingDeviceMenu();
  });

  window.addEventListener("resize", () => {
    if (!menu.hidden) positionStreamingDeviceMenu();
  });
}

function toggleStreamingDeviceFields() {
  const type = document.getElementById("streaming-device-type").value;
  document.getElementById("streaming-device-wol-row").style.display =
    type === "wol" ? "" : "none";
  document.getElementById("streaming-device-adb-row").style.display =
    type === "adb" ? "" : "none";
  document.getElementById("streaming-device-roku-row").style.display =
    type === "roku" ? "" : "none";
  const wakeOnPowerRow = document.getElementById(
    "streaming-device-wake-on-power-row",
  );
  if (wakeOnPowerRow) wakeOnPowerRow.style.display = type ? "" : "none";
  const saveRow = document.getElementById("streaming-device-save-row");
  if (saveRow) saveRow.style.display = type ? "" : "none";
}

async function onStreamingDeviceTypeChange() {
  const type = document.getElementById("streaming-device-type").value;
  toggleStreamingDeviceFields();
  if (type === "") {
    await clearStreamingDevice();
  }
}

async function clearStreamingDevice() {
  try {
    await invoke("set_streaming_device", { device: null });
    await invoke("set_wake_streaming_on_power_on", { enabled: false });
    config = await invoke("get_config");
    const wakeStreamingBtn = document.getElementById("wake-streaming-btn");
    if (wakeStreamingBtn) wakeStreamingBtn.style.display = "none";
  } catch (e) {
    console.error("Failed to clear streaming device:", e);
  }
}

function buildWolStreamingDevice() {
  const mac = document.getElementById("streaming-device-mac").value.trim();
  if (!mac) {
    return {
      error:
        "Enter the device MAC address (e.g. from router or Shield settings)",
    };
  }
  const broadcast_ip =
    document.getElementById("streaming-device-wol-broadcast").value.trim() ||
    null;
  return { device: { type: "wol", mac, broadcast_ip } };
}

function buildAdbStreamingDevice() {
  const ip = document.getElementById("streaming-device-adb-ip").value.trim();
  if (!ip) {
    return {
      error:
        "Enter the device IP address (Shield: enable Network debugging in Developer options)",
    };
  }
  const portStr = document
    .getElementById("streaming-device-adb-port")
    .value.trim();
  const port = portStr ? Number.parseInt(portStr, 10) : 5555;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return { error: "ADB port must be 1–65535 (default 5555)" };
  }
  return { device: { type: "adb", ip, port: port === 5555 ? null : port } };
}

function buildRokuStreamingDevice() {
  const ip = document.getElementById("streaming-device-ip").value.trim();
  if (!ip) {
    return { error: "Enter the Roku IP address" };
  }
  return { device: { type: "roku", ip } };
}

function buildStreamingDeviceFromForm(type) {
  switch (type) {
    case "wol":
      return buildWolStreamingDevice();
    case "adb":
      return buildAdbStreamingDevice();
    case "roku":
      return buildRokuStreamingDevice();
    default:
      return { device: null };
  }
}

async function saveStreamingDevice() {
  const type = document.getElementById("streaming-device-type").value;
  const { device, error } = buildStreamingDeviceFromForm(type);
  if (error) {
    showToast(error, "error");
    return;
  }
  try {
    await invoke("set_streaming_device", { device });
    await invoke("set_wake_streaming_on_power_on", {
      enabled: document.getElementById("wake-streaming-on-power-on").checked,
    });
    config = await invoke("get_config");
    document.getElementById("wake-streaming-btn").style.display =
      config.streaming_device ? "" : "none";
    showToast("Streaming device saved", "success");
  } catch (e) {
    showToast(e, "error");
  }
}

async function wakeStreamingDevice() {
  try {
    const result = await invoke("wake_streaming_device");
    showToast(result.message || "Wake sent", "success");
  } catch (e) {
    showToast(e, "error");
  }
}

async function saveMac() {
  const mac = document.getElementById("mac-input").value.trim();
  if (!mac) {
    showToast("Please enter a MAC address", "error");
    return;
  }

  try {
    const result = await invoke("set_mac", { mac });
    showToast(result.message || "MAC address saved", "success");
    // Reload config to update display
    await loadConfig();
  } catch (e) {
    showToast(e, "error");
  }
}

async function quitApp() {
  await invoke("quit_app");
}

// ============ Connection ============

async function connectTv() {
  setConnecting();

  try {
    await invoke("connect");
    setStatus(true, "Connected");
    showToast("Connected to TV", "success");

    // Collapse settings on successful connect
    document.getElementById("settings-panel").classList.add("collapsed");
  } catch (e) {
    setStatus(false);
    showToast(e, "error");
  }
}

async function authenticate() {
  const name = document.getElementById("tv-name").value.trim();
  const ip = document.getElementById("tv-ip").value.trim();
  const useSsl = document.getElementById("use-ssl").checked;

  if (!name || !ip) {
    showToast("Please enter TV name and IP", "error");
    return;
  }

  setConnecting();
  document.getElementById("status-text").textContent = "Check TV for prompt...";

  try {
    await invoke("authenticate", { name, ip, useSsl });
    setStatus(true, "Connected");
    showToast("Authenticated! Key saved.", "success");

    // Reload config
    await loadConfig();

    // Collapse settings
    document.getElementById("settings-panel").classList.add("collapsed");
  } catch (e) {
    setStatus(false);
    showToast(e, "error");
  }
}

// ============ Config ============

function populateTvConfigFields() {
  if (!config.active_tv || !config.tvs[config.active_tv]) return;

  const tv = config.tvs[config.active_tv];
  document.getElementById("tv-name").value = config.active_tv;
  document.getElementById("tv-ip").value = tv.ip || "";
  document.getElementById("use-ssl").checked = tv.use_ssl !== false;

  const macInput = document.getElementById("mac-input");
  const macStatus = document.getElementById("mac-status");
  if (tv.mac) {
    macInput.value = tv.mac;
    macStatus.textContent = "MAC saved - Wake-on-LAN ready";
    macStatus.className = "hint success";
  } else {
    macInput.value = "";
    macStatus.textContent = "Not set - fetch while connected or enter manually";
    macStatus.className = "hint warning";
  }
}

function populateStreamingDeviceFields(streamingDevice) {
  if (!streamingDevice) {
    setStreamingDeviceType("");
    return;
  }

  switch (streamingDevice.type) {
    case "wol":
      setStreamingDeviceType("wol");
      document.getElementById("streaming-device-mac").value =
        streamingDevice.mac || "";
      document.getElementById("streaming-device-wol-broadcast").value =
        streamingDevice.broadcast_ip || "";
      break;
    case "adb":
      setStreamingDeviceType("adb");
      document.getElementById("streaming-device-adb-ip").value =
        streamingDevice.ip || "";
      document.getElementById("streaming-device-adb-port").value =
        streamingDevice.port ? String(streamingDevice.port) : "5555";
      break;
    case "roku":
      setStreamingDeviceType("roku");
      document.getElementById("streaming-device-ip").value =
        streamingDevice.ip || "";
      break;
    default:
      setStreamingDeviceType("");
  }
}

function updateWakeStreamingButton() {
  const wakeStreamingBtn = document.getElementById("wake-streaming-btn");
  if (wakeStreamingBtn) {
    wakeStreamingBtn.style.display = config.streaming_device ? "" : "none";
  }
}

function applyConnectionUiAfterConfigLoad() {
  if (config.active_tv && config.tvs[config.active_tv]?.client_key) {
    connectTv();
    return;
  }

  setStatus(false);
  document.getElementById("settings-panel").classList.remove("collapsed");
}

async function loadConfig() {
  try {
    config = await invoke("get_config");

    populateTvConfigFields();
    populateStreamingDeviceFields(config.streaming_device);
    document.getElementById("wake-streaming-on-power-on").checked =
      config.wake_streaming_on_power_on === true;
    toggleStreamingDeviceFields();
    updateWakeStreamingButton();

    await loadShortcutSettings();
    await loadActionShortcuts();
    await loadAutostartSettings();
    await loadVersion();
    await applyNixUpdateNotice();

    applyConnectionUiAfterConfigLoad();
  } catch (e) {
    console.error("Failed to load config:", e);
  }
}

async function loadShortcutSettings() {
  try {
    const [shortcut, enabled] = await invoke("get_shortcut_settings");
    currentShortcut = shortcut;
    shortcutEnabled = enabled;
    document.getElementById("shortcut-input").value = shortcut;
    document.getElementById("shortcut-enabled").checked = enabled;
  } catch (e) {
    console.error("Failed to load shortcut settings:", e);
  }
}

const NIX_UPDATE_HINT =
  "Installed with Nix. Update the lgtv-remote flake input and rebuild.";

let selfUpdatesSupported = true;

async function applyNixUpdateNotice() {
  try {
    selfUpdatesSupported = await invoke("self_updates_supported");
  } catch (e) {
    console.error("Failed to check self-update support:", e);
    selfUpdatesSupported = true;
  }
  const installBtn = document.getElementById("btn-install-update");
  const wrap = document.getElementById("update-check-wrap");
  const button = document.getElementById("btn-check-updates");
  if (!selfUpdatesSupported) {
    if (installBtn) installBtn.style.display = "none";
    if (wrap) wrap.title = NIX_UPDATE_HINT;
    if (button) button.title = NIX_UPDATE_HINT;
  }
}

function showUpdateAvailable(version, { toast = false } = {}) {
  const banner = document.getElementById("update-banner");
  const text = document.getElementById("update-banner-text");
  const installBtn = document.getElementById("btn-install-update");
  if (!banner || !text) return;
  if (selfUpdatesSupported) {
    text.textContent = `Update ${version} available.`;
    if (installBtn) installBtn.style.display = "";
  } else {
    text.textContent = `Update ${version} available. ${NIX_UPDATE_HINT}`;
    if (installBtn) installBtn.style.display = "none";
    if (toast) {
      showToast(`Update ${version} available. ${NIX_UPDATE_HINT}`, "info");
    }
  }
  banner.style.display = "";
}

async function loadVersion() {
  try {
    const version = await invoke("get_app_version");
    document.getElementById("app-version").textContent = `Version ${version}`;
  } catch (e) {
    console.error("Failed to load version:", e);
  }
  startDevWindowSize();
}

let devWindowSizeInterval = null;

async function startDevWindowSize() {
  if (devWindowSizeInterval) {
    clearInterval(devWindowSizeInterval);
    devWindowSizeInterval = null;
  }
  try {
    const dev = await invoke("is_dev");
    const el = document.getElementById("window-size-dev");
    if (!dev || !el) return;
    el.setAttribute("aria-hidden", "false");
    const update = async () => {
      try {
        // Returns the main window's outer size (total window, including any OS frame).
        const [w, h] = await invoke("get_window_size");
        const innerW = Math.max(0, (w || 0) - OUTER_FRAME_W);
        const innerH = Math.max(0, (h || 0) - OUTER_FRAME_H);
        el.textContent = ` · ${innerW} × ${innerH}`;
      } catch (error) {
        console.debug("Failed to get window size:", error);
        el.textContent = "";
      }
    };
    await update();
    devWindowSizeInterval = setInterval(update, 200);
  } catch (error) {
    console.debug("Dev window size overlay unavailable:", error);
  }
}

async function resetWindowSize() {
  try {
    await invoke("reset_window_size");
    showToast("Window size reset to default", "success");
  } catch (e) {
    showToast(e, "error");
  }
}

async function loadAutostartSettings() {
  try {
    const enabled = await invoke("get_autostart_enabled");
    document.getElementById("autostart-enabled").checked = enabled;
  } catch (e) {
    console.error("Failed to load autostart setting:", e);
  }
}

async function toggleAutostart() {
  const enabled = document.getElementById("autostart-enabled").checked;
  try {
    await invoke("set_autostart_enabled", { enabled });
    showToast(
      enabled ? "App will start with your computer" : "Autostart disabled",
      "success",
    );
  } catch (e) {
    showToast(e, "error");
    document.getElementById("autostart-enabled").checked = !enabled;
  }
}

async function toggleShortcut() {
  const enabled = document.getElementById("shortcut-enabled").checked;
  const shortcut = document.getElementById("shortcut-input").value.trim();

  if (enabled && !shortcut) {
    showToast("Please set a shortcut first", "error");
    document.getElementById("shortcut-enabled").checked = false;
    return;
  }

  await saveShortcut(shortcut, enabled);
}

async function saveShortcut(shortcut, enabled) {
  try {
    await invoke("set_shortcut", { shortcut, enabled });
    currentShortcut = shortcut;
    shortcutEnabled = enabled;
    let toastMessage;
    if (enabled && shortcut) {
      toastMessage = `Shortcut: ${shortcut}`;
    } else if (shortcut) {
      toastMessage = "Shortcut disabled";
    } else {
      toastMessage = "Shortcut cleared";
    }
    showToast(toastMessage, "success");
  } catch (e) {
    showToast(e, "error");
    // Revert UI on error
    document.getElementById("shortcut-input").value = currentShortcut;
    document.getElementById("shortcut-enabled").checked = shortcutEnabled;
  }
}

function clearGlobalShortcut() {
  const input = document.getElementById("shortcut-input");
  input.value = "";
  currentShortcut = "";
  const enabled = document.getElementById("shortcut-enabled").checked;
  saveShortcut("", enabled);
}

// Shortcut recorder
function setupShortcutRecorder() {
  const input = document.getElementById("shortcut-input");
  const hint = document.getElementById("shortcut-hint");

  input.addEventListener("focus", () => {
    isRecordingShortcut = true;
    recordedKeys.clear();
    input.classList.add("recording");
    hint.classList.add("recording");
    hint.textContent = "Press key combination...";
    input.value = "";
  });

  input.addEventListener("blur", async () => {
    isRecordingShortcut = false;
    input.classList.remove("recording");
    hint.classList.remove("recording");
    hint.textContent = "Click to record shortcut";

    const newShortcut = input.value.trim();
    if (newShortcut && newShortcut !== currentShortcut) {
      // Save the new shortcut
      const enabled = document.getElementById("shortcut-enabled").checked;
      await saveShortcut(newShortcut, enabled);
    } else if (!newShortcut) {
      // Restore previous shortcut if nothing recorded
      input.value = currentShortcut;
    }

    recordedKeys.clear();
  });

  input.addEventListener("keydown", (e) => {
    if (!isRecordingShortcut) return;

    e.preventDefault();
    e.stopPropagation();

    // Record only the current combination (modifiers + this key), not accumulated keys
    const key = mapKeyToTauri(e);
    if (key) {
      recordedKeys = eventToKeySet(e);
      updateShortcutDisplay(input);
    }
  });

  input.addEventListener("keyup", (e) => {
    if (!isRecordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();
  });
}

function mapKeyToTauri(e) {
  // Modifiers
  if (e.key === "Control") return "Ctrl";
  if (e.key === "Alt") return "Alt";
  if (e.key === "Shift") return "Shift";
  if (e.key === "Meta" || e.key === "Super") return "Super";

  // Space (e.key is ' ') — must be before regular keys
  if (e.key === " ") return "Space";

  // Regular keys
  if (e.key.length === 1) {
    return e.key.toUpperCase();
  }

  // Special keys
  const specialKeys = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Enter: "Return",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    F1: "F1",
    F2: "F2",
    F3: "F3",
    F4: "F4",
    F5: "F5",
    F6: "F6",
    F7: "F7",
    F8: "F8",
    F9: "F9",
    F10: "F10",
    F11: "F11",
    F12: "F12",
  };

  return specialKeys[e.key] || null;
}

function updateShortcutDisplay(input) {
  // Order: Super, Ctrl, Alt, Shift, then other keys
  const modOrder = ["Super", "Ctrl", "Alt", "Shift"];
  const mods = [];
  const keys = [];

  for (const key of recordedKeys) {
    if (modOrder.includes(key)) {
      mods.push(key);
    } else {
      keys.push(key);
    }
  }

  // Sort modifiers in standard order
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));

  const shortcut = [...mods, ...keys].join("+");
  input.value = shortcut;
}

function buildShortcutFromKeys(keysSet) {
  const modOrder = ["Super", "Ctrl", "Alt", "Shift"];
  const mods = [];
  const keys = [];
  for (const key of keysSet) {
    if (modOrder.includes(key)) mods.push(key);
    else keys.push(key);
  }
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
  return [...mods, ...keys].join("+");
}

function eventToShortcutString(e) {
  const keys = new Set();
  if (e.metaKey) keys.add("Super");
  if (e.ctrlKey) keys.add("Ctrl");
  if (e.altKey) keys.add("Alt");
  if (e.shiftKey) keys.add("Shift");
  const key = mapKeyToTauri(e);
  if (key) keys.add(key);
  return buildShortcutFromKeys(keys);
}

/** Build the set of keys (for recording) from a single keydown: current modifiers + the key. */
function eventToKeySet(e) {
  const keys = new Set();
  if (e.metaKey) keys.add("Super");
  if (e.ctrlKey) keys.add("Ctrl");
  if (e.altKey) keys.add("Alt");
  if (e.shiftKey) keys.add("Shift");
  const key = mapKeyToTauri(e);
  if (key) keys.add(key);
  return keys;
}

// ============ Action Shortcuts ============

function buildShortcutToActionMap() {
  shortcutToAction = {};
  for (const [id, ac] of Object.entries(actionShortcuts)) {
    if (ac.shortcut?.trim()) {
      shortcutToAction[ac.shortcut.trim()] = id;
    }
  }
}

async function loadActionShortcuts() {
  try {
    const loaded = await invoke("get_action_shortcuts");
    actionShortcuts = {};
    for (const a of ACTIONS) {
      const c = loaded[a.id];
      actionShortcuts[a.id] = {
        shortcut: c?.shortcut == null ? a.defaultShortcut : c.shortcut,
        global: c?.global == null ? false : c.global,
      };
    }
    buildShortcutToActionMap();
    renderShortcutsList();
    setupActionShortcutRecorders();
  } catch (e) {
    console.error("Failed to load action shortcuts:", e);
  }
}

function renderShortcutsList() {
  const list = document.getElementById("shortcuts-list");
  list.innerHTML = "";
  for (const a of ACTIONS) {
    const ac = actionShortcuts[a.id] || {
      shortcut: a.defaultShortcut,
      global: false,
    };
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.dataset.actionId = a.id;
    row.innerHTML = `
      <label class="shortcut-label">${escapeHtml(a.label)}</label>
      <input type="text" class="shortcut-input-action" data-action-id="${escapeHtml(a.id)}" value="${escapeHtml(ac.shortcut)}" placeholder="Click and press keys..." readonly>
      <button type="button" class="btn-clear-shortcut" data-action-id="${escapeHtml(a.id)}" title="Clear shortcut; click when empty to reset to default" aria-label="Clear shortcut; click when empty to reset to default">&times;</button>
      <label class="shortcut-global-label">
        <input type="checkbox" class="shortcut-global-cb" data-action-id="${escapeHtml(a.id)}" ${ac.global ? "checked" : ""}>
        Global
      </label>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll(".shortcut-global-cb").forEach((cb) => {
    cb.addEventListener("change", onActionGlobalChange);
  });
  list.querySelectorAll(".btn-clear-shortcut").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.actionId;
      if (!id || !actionShortcuts[id]) return;
      const row = e.target.closest(".shortcut-row");
      const input = row?.querySelector(".shortcut-input-action");
      const cb = row?.querySelector(".shortcut-global-cb");
      const isEmpty = !input?.value?.trim();
      if (isEmpty) {
        const action = ACTIONS.find((a) => a.id === id);
        const defaultShortcut = action ? action.defaultShortcut : "";
        actionShortcuts[id].shortcut = defaultShortcut;
        actionShortcuts[id].global = false;
        if (input) input.value = defaultShortcut;
        if (cb) cb.checked = false;
        showToast("Reset to default", "success");
      } else {
        actionShortcuts[id].shortcut = "";
        actionShortcuts[id].global = false;
        if (input) input.value = "";
        if (cb) cb.checked = false;
      }
      buildShortcutToActionMap();
      saveActionShortcuts();
    });
  });
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function onActionGlobalChange(e) {
  const id = e.target.dataset.actionId;
  const global = e.target.checked;
  if (actionShortcuts[id]) {
    actionShortcuts[id].global = global;
    saveActionShortcuts();
  }
}

function collectActionShortcutsFromDOM() {
  document.querySelectorAll(".shortcut-row").forEach((row) => {
    const id = row.dataset.actionId;
    const input = row.querySelector(".shortcut-input-action");
    const cb = row.querySelector(".shortcut-global-cb");
    if (id && actionShortcuts[id]) {
      if (input) actionShortcuts[id].shortcut = input.value.trim();
      if (cb) actionShortcuts[id].global = cb.checked;
    }
  });
}

async function saveActionShortcuts() {
  collectActionShortcutsFromDOM();
  try {
    await invoke("set_action_shortcuts", { shortcuts: actionShortcuts });
    buildShortcutToActionMap();
    showToast("Shortcuts saved", "success");
  } catch (e) {
    showToast(e, "error");
  }
}

function setupActionShortcutRecorders() {
  document.querySelectorAll(".shortcut-input-action").forEach((input) => {
    const actionId = input.dataset.actionId;
    input.addEventListener("focus", () => {
      isRecordingActionShortcut = actionId;
      input.classList.add("recording");
      input.value = "";
    });
    input.addEventListener("blur", async () => {
      isRecordingActionShortcut = null;
      input.classList.remove("recording");
      const newShortcut = input.value.trim();
      if (actionShortcuts[actionId]) {
        actionShortcuts[actionId].shortcut = newShortcut;
        buildShortcutToActionMap();
        await saveActionShortcuts();
      }
      if (!newShortcut && ACTIONS.some((a) => a.id === actionId)) {
        input.value = ACTIONS.find((a) => a.id === actionId).defaultShortcut;
        if (actionShortcuts[actionId]) {
          actionShortcuts[actionId].shortcut = input.value;
          await saveActionShortcuts();
        }
      }
    });
    input.addEventListener("keydown", (e) => {
      if (isRecordingActionShortcut !== actionId) return;
      e.preventDefault();
      e.stopPropagation();
      const key = mapKeyToTauri(e);
      if (key) {
        // Record only the current combination (modifiers + this key), not accumulated keys
        const keys = eventToKeySet(e);
        input.value = buildShortcutFromKeys(keys);
      }
    });
    input.addEventListener("keyup", (e) => {
      if (isRecordingActionShortcut === actionId) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  });
}

async function runAction(actionId) {
  switch (actionId) {
    case "up":
      return sendButton("UP");
    case "down":
      return sendButton("DOWN");
    case "left":
      return sendButton("LEFT");
    case "right":
      return sendButton("RIGHT");
    case "enter":
      return sendButton("ENTER");
    case "back":
      return sendButton("BACK");
    case "play":
      return sendButton("PLAY");
    case "pause":
      return sendButton("PAUSE");
    case "stop":
      return sendButton("STOP");
    case "fast_forward":
      return sendButton("FAST_FORWARD");
    case "rewind":
      return sendButton("REWIND");
    case "volume_up":
      return volumeUp();
    case "volume_down":
      return volumeDown();
    case "mute":
      return setMute(true);
    case "unmute":
      return setMute(false);
    case "power_on":
      return powerOn();
    case "power_off":
      return powerOff();
    case "wake_streaming_device":
      return wakeStreamingDevice();
    case "home":
      return sendButton("HOME");
    default:
      return;
  }
}

// ============ Keyboard Shortcuts ============

document.addEventListener("keydown", (e) => {
  if (
    e.target.tagName === "INPUT" ||
    isRecordingShortcut ||
    isRecordingActionShortcut
  )
    return;

  const shortcutStr = eventToShortcutString(e);
  const actionId = shortcutToAction[shortcutStr];
  if (actionId) {
    runAction(actionId);
    e.preventDefault();
  }
});

// Add click feedback to all buttons
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("btn")) {
    buttonFeedback(e.target);
  }
});

// ============ Status Check ============

// Check actual connection status from backend. When window becomes visible (e.g.
// after clicking outside on Windows, where the connection may have dropped),
// auto-reconnect if we have saved credentials so the user doesn't have to
// press Connect manually.
async function checkStatus() {
  try {
    const connected = await invoke("get_status");
    if (isConnected && !connected) {
      // We thought we were connected but we're not (e.g. connection dropped
      // while window was hidden on Windows). Auto-reconnect if we have creds.
      setStatus(false, "Disconnected");
      if (hasConnectionInfo()) {
        connectTv();
      }
    } else if (!isConnected && connected) {
      // Backend says connected
      setStatus(true, "Connected");
    }
  } catch (e) {
    console.error("Status check failed:", e);
  }
}

// ============ Init ============

document.addEventListener("DOMContentLoaded", () => {
  setupStreamingDeviceTypePicker();
  loadConfig();
  setupShortcutRecorder();
  listenRunCommand();
  listenConnectionLost();
  listenUpdateCheckResult();
});

function listenRunCommand() {
  if (globalThis.__TAURI__?.event) {
    globalThis.__TAURI__.event.listen("run-command", (e) => {
      const actionId = e.payload;
      if (actionId && typeof runAction === "function") {
        runAction(actionId);
      }
    });
  }
}

// When keepalive detects connection dropped in background, sync UI
function listenConnectionLost() {
  if (globalThis.__TAURI__?.event) {
    globalThis.__TAURI__.event.listen("connection-lost", () => {
      setStatus(false, "Disconnected");
    });
  }
}

function listenUpdateCheckResult() {
  if (globalThis.__TAURI__?.event) {
    globalThis.__TAURI__.event.listen("update-check-result", (e) => {
      const payload = e.payload;
      const banner = document.getElementById("update-banner");
      const text = document.getElementById("update-banner-text");
      if (!banner || !text) return;
      if (payload?.self_updates_supported === false) {
        selfUpdatesSupported = false;
      }
      if (payload?.version) {
        showUpdateAvailable(payload.version, { toast: !selfUpdatesSupported });
      } else {
        text.textContent = "You're on the latest version.";
        banner.style.display = "";
        document.getElementById("btn-install-update").style.display = "none";
        setTimeout(() => {
          banner.style.display = "none";
          if (selfUpdatesSupported) {
            document.getElementById("btn-install-update").style.display = "";
          }
        }, 3000);
      }
    });
  }
}

async function checkForUpdates() {
  try {
    const meta = await invoke("check_for_updates");
    const banner = document.getElementById("update-banner");
    const text = document.getElementById("update-banner-text");
    if (!banner || !text) return;
    if (meta?.self_updates_supported === false) {
      selfUpdatesSupported = false;
    }
    if (meta?.version) {
      showUpdateAvailable(meta.version, { toast: !selfUpdatesSupported });
    } else {
      text.textContent = "You're on the latest version.";
      document.getElementById("btn-install-update").style.display = "none";
      banner.style.display = "";
      setTimeout(() => {
        banner.style.display = "none";
      }, 3000);
    }
  } catch (e) {
    showToast(e?.toString?.() || "Update check failed", "error");
  }
}

async function installUpdate() {
  try {
    await invoke("download_and_install_update");
    showToast("Installing update…", "success");
  } catch (e) {
    showToast(e?.toString?.() || "Install failed", "error");
  }
}

// Expose handlers referenced from inline HTML event attributes.
Object.assign(globalThis, {
  authenticate,
  checkForUpdates,
  clearGlobalShortcut,
  fetchMac,
  installUpdate,
  onStreamingDeviceTypeChange,
  onVolumeSliderInput,
  quitApp,
  resetWindowSize,
  saveMac,
  saveStreamingDevice,
  setVolumeLevel,
  toggleApps,
  toggleAutostart,
  toggleSettings,
  toggleShortcut,
  toggleShortcuts,
});

// Check status when window becomes visible (user clicked tray icon)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkStatus();
  }
  // Pause dev window size polling when hidden to avoid unnecessary invokes
  const el = document.getElementById("window-size-dev");
  if (el?.textContent) {
    if (document.visibilityState === "hidden" && devWindowSizeInterval) {
      clearInterval(devWindowSizeInterval);
      devWindowSizeInterval = null;
    } else if (
      document.visibilityState === "visible" &&
      !devWindowSizeInterval
    ) {
      startDevWindowSize();
    }
  }
});
