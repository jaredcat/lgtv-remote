// Tauri API is injected globally via withGlobalTauri in tauri.conf.json
const invoke = window.__TAURI__.core.invoke;

// On Windows (decorations: false), outer = inner + (16, 9). Used so dev size display
// matches tauri.conf.json (inner size). Non-Windows uses 0 so display = outer.
const OUTER_FRAME_W = 16;
const OUTER_FRAME_H = 9;

// ============ State ============
let isConnected = false;
let config = null;
let shortcutEnabled = false;
let currentShortcut = '';
let isRecordingShortcut = false;
let recordedKeys = new Set();

// Action shortcuts: id -> { shortcut, global }. shortcutToAction maps shortcut string -> id for keydown.
let actionShortcuts = {};
let shortcutToAction = {};
let isRecordingActionShortcut = null; // action id when recording, else null
let recordedActionKeys = new Set();

const ACTIONS = [
  { id: 'up', label: 'Up', defaultShortcut: 'Up' },
  { id: 'down', label: 'Down', defaultShortcut: 'Down' },
  { id: 'left', label: 'Left', defaultShortcut: 'Left' },
  { id: 'right', label: 'Right', defaultShortcut: 'Right' },
  { id: 'enter', label: 'OK / Enter', defaultShortcut: 'Return' },
  { id: 'back', label: 'Back', defaultShortcut: 'Backspace' },
  { id: 'rewind', label: 'Rewind', defaultShortcut: '[' },
  { id: 'play', label: 'Play', defaultShortcut: 'Space' },
  { id: 'pause', label: 'Pause', defaultShortcut: 'P' },
  { id: 'stop', label: 'Stop', defaultShortcut: 'S' },
  { id: 'fast_forward', label: 'Fast Forward', defaultShortcut: ']' },
  { id: 'volume_up', label: 'Volume Up', defaultShortcut: '=' },
  { id: 'volume_down', label: 'Volume Down', defaultShortcut: '-' },
  { id: 'mute', label: 'Mute', defaultShortcut: 'Shift+-' },
  { id: 'unmute', label: 'Unmute', defaultShortcut: 'Shift+=' },
  { id: 'power_on', label: 'Power On', defaultShortcut: 'F7' },
  { id: 'power_off', label: 'Power Off', defaultShortcut: 'F8' },
  { id: 'home', label: 'Home', defaultShortcut: 'Home' },
  {
    id: 'wake_streaming_device',
    label: 'Wake streaming device',
    defaultShortcut: '',
  },
];

// ============ UI Helpers ============

function hasConnectionInfo() {
  return Boolean(
    config && config.active_tv && config.tvs?.[config.active_tv]?.client_key,
  );
}

function setStatus(connected, text) {
  isConnected = connected;
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const connectBtn = document.getElementById('status-connect-btn');

  dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  if (connected) {
    statusText.textContent = text || 'Connected';
    statusText.style.display = '';
    connectBtn.style.display = 'none';
  } else {
    if (hasConnectionInfo()) {
      statusText.style.display = 'none';
      connectBtn.style.display = '';
    } else {
      statusText.textContent = text || 'Not Connected';
      statusText.style.display = '';
      connectBtn.style.display = 'none';
    }
  }
}

function setConnecting() {
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const connectBtn = document.getElementById('status-connect-btn');

  dot.className = 'dot connecting';
  statusText.textContent = 'Connecting...';
  statusText.style.display = '';
  connectBtn.style.display = 'none';
}

function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Show
  setTimeout(() => toast.classList.add('show'), 10);

  // Hide after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('collapsed');
}

function toggleShortcuts() {
  const panel = document.getElementById('shortcuts-panel');
  panel.classList.toggle('collapsed');
}

function buttonFeedback(element) {
  element.classList.add('active');
  setTimeout(() => element.classList.remove('active'), 100);
}

// ============ TV Commands ============

// Check if error indicates we are no longer connected (single source of truth for UI)
function isDisconnectError(error) {
  const msg = String(error).toLowerCase();
  return (
    msg.includes('disconnected') ||
    msg.includes('not connected') ||
    msg.includes('connection closed') ||
    msg.includes('timeout') ||
    msg.includes('send failed') ||
    msg.includes('websocket error')
  );
}

// Handle command errors - update status if disconnected
function handleCommandError(e) {
  showToast(e, 'error');
  if (isDisconnectError(e)) {
    setStatus(false, 'Disconnected');
  }
}

async function sendButton(button) {
  if (!isConnected) {
    showToast('Not connected', 'error');
    return;
  }

  try {
    await invoke('send_button', { button });
  } catch (e) {
    handleCommandError(e);
  }
}

async function volumeUp() {
  if (!isConnected) {
    showToast('Not connected', 'error');
    return;
  }

  try {
    await invoke('volume_up');
  } catch (e) {
    handleCommandError(e);
  }
}

async function volumeDown() {
  if (!isConnected) {
    showToast('Not connected', 'error');
    return;
  }

  try {
    await invoke('volume_down');
  } catch (e) {
    handleCommandError(e);
  }
}

async function setMute(mute) {
  if (!isConnected) {
    showToast('Not connected', 'error');
    return;
  }

  try {
    await invoke('set_mute', { mute });
    showToast(mute ? 'Muted' : 'Unmuted', 'success');
  } catch (e) {
    handleCommandError(e);
  }
}

const POWER_ON_RECONNECT_INTERVAL_MS = 1000;
const POWER_ON_RECONNECT_MAX_TRIES = 10;

async function powerOn() {
  try {
    const result = await invoke('power_on');
    showToast(result.message || 'Wake-on-LAN sent. Connecting...', 'success');
    // Try to connect every 1s, up to 10 times
    let tries = 0;
    const tryConnect = async () => {
      tries += 1;
      setConnecting();
      try {
        await invoke('connect');
        setStatus(true, 'Connected');
        showToast('Connected to TV', 'success');
        return;
      } catch (e) {
        if (tries < POWER_ON_RECONNECT_MAX_TRIES) {
          setTimeout(tryConnect, POWER_ON_RECONNECT_INTERVAL_MS);
        } else {
          setStatus(false);
          showToast('TV did not respond after 10 tries', 'error');
        }
      }
    };
    setTimeout(tryConnect, POWER_ON_RECONNECT_INTERVAL_MS);
  } catch (e) {
    showToast(e, 'error');
  }
}

async function powerOff() {
  if (!isConnected) {
    showToast('Not connected', 'error');
    return;
  }

  try {
    await invoke('power_off');
    setStatus(false, 'TV Off');
    showToast('TV powered off', 'success');
  } catch (e) {
    handleCommandError(e);
  }
}

async function fetchMac() {
  if (!isConnected) {
    showToast('Connect to TV first', 'error');
    return;
  }

  try {
    const result = await invoke('fetch_mac');
    showToast(result.message || 'MAC address fetched', 'success');
    // Reload config to update the MAC display
    await loadConfig();
  } catch (e) {
    handleCommandError(e);
  }
}

function toggleStreamingDeviceFields() {
  const type = document.getElementById('streaming-device-type').value;
  document.getElementById('streaming-device-wol-row').style.display =
    type === 'wol' ? '' : 'none';
  document.getElementById('streaming-device-adb-row').style.display =
    type === 'adb' ? '' : 'none';
  document.getElementById('streaming-device-roku-row').style.display =
    type === 'roku' ? '' : 'none';
  const wakeOnPowerRow = document.getElementById(
    'streaming-device-wake-on-power-row',
  );
  if (wakeOnPowerRow) wakeOnPowerRow.style.display = type ? '' : 'none';
  const saveRow = document.getElementById('streaming-device-save-row');
  if (saveRow) saveRow.style.display = type ? '' : 'none';
}

async function onStreamingDeviceTypeChange() {
  const type = document.getElementById('streaming-device-type').value;
  toggleStreamingDeviceFields();
  if (type === '') {
    await clearStreamingDevice();
  }
}

async function clearStreamingDevice() {
  try {
    await invoke('set_streaming_device', { device: null });
    await invoke('set_wake_streaming_on_power_on', { enabled: false });
    config = await invoke('get_config');
    const wakeStreamingBtn = document.getElementById('wake-streaming-btn');
    if (wakeStreamingBtn) wakeStreamingBtn.style.display = 'none';
  } catch (e) {
    console.error('Failed to clear streaming device:', e);
  }
}

async function saveStreamingDevice() {
  const type = document.getElementById('streaming-device-type').value;
  let device = null;
  if (type === 'wol') {
    const mac = document.getElementById('streaming-device-mac').value.trim();
    if (!mac) {
      showToast(
        'Enter the device MAC address (e.g. from router or Shield settings)',
        'error',
      );
      return;
    }
    const broadcast_ip =
      document.getElementById('streaming-device-wol-broadcast').value.trim() ||
      null;
    device = { type: 'wol', mac, broadcast_ip };
  } else if (type === 'adb') {
    const ip = document.getElementById('streaming-device-adb-ip').value.trim();
    if (!ip) {
      showToast(
        'Enter the device IP address (Shield: enable Network debugging in Developer options)',
        'error',
      );
      return;
    }
    const portStr = document
      .getElementById('streaming-device-adb-port')
      .value.trim();
    const port = portStr ? parseInt(portStr, 10) : 5555;
    if (isNaN(port) || port < 1 || port > 65535) {
      showToast('ADB port must be 1–65535 (default 5555)', 'error');
      return;
    }
    device = { type: 'adb', ip, port: port === 5555 ? null : port };
  } else if (type === 'roku') {
    const ip = document.getElementById('streaming-device-ip').value.trim();
    if (!ip) {
      showToast('Enter the Roku IP address', 'error');
      return;
    }
    device = { type: 'roku', ip };
  }
  try {
    await invoke('set_streaming_device', { device });
    await invoke('set_wake_streaming_on_power_on', {
      enabled: document.getElementById('wake-streaming-on-power-on').checked,
    });
    config = await invoke('get_config');
    document.getElementById('wake-streaming-btn').style.display =
      config.streaming_device ? '' : 'none';
    showToast('Streaming device saved', 'success');
  } catch (e) {
    showToast(e, 'error');
  }
}

async function wakeStreamingDevice() {
  try {
    const result = await invoke('wake_streaming_device');
    showToast(result.message || 'Wake sent', 'success');
  } catch (e) {
    showToast(e, 'error');
  }
}

async function saveMac() {
  const mac = document.getElementById('mac-input').value.trim();
  if (!mac) {
    showToast('Please enter a MAC address', 'error');
    return;
  }

  try {
    const result = await invoke('set_mac', { mac });
    showToast(result.message || 'MAC address saved', 'success');
    // Reload config to update display
    await loadConfig();
  } catch (e) {
    showToast(e, 'error');
  }
}

async function quitApp() {
  await invoke('quit_app');
}

// ============ Connection ============

async function connectTv() {
  setConnecting();

  try {
    const result = await invoke('connect');
    setStatus(true, 'Connected');
    showToast('Connected to TV', 'success');

    // Collapse settings on successful connect
    document.getElementById('settings-panel').classList.add('collapsed');
  } catch (e) {
    setStatus(false);
    showToast(e, 'error');
  }
}

async function authenticate() {
  const name = document.getElementById('tv-name').value.trim();
  const ip = document.getElementById('tv-ip').value.trim();
  const useSsl = document.getElementById('use-ssl').checked;

  if (!name || !ip) {
    showToast('Please enter TV name and IP', 'error');
    return;
  }

  setConnecting();
  document.getElementById('status-text').textContent = 'Check TV for prompt...';

  try {
    const result = await invoke('authenticate', { name, ip, useSsl });
    setStatus(true, 'Connected');
    showToast('Authenticated! Key saved.', 'success');

    // Reload config
    await loadConfig();

    // Collapse settings
    document.getElementById('settings-panel').classList.add('collapsed');
  } catch (e) {
    setStatus(false);
    showToast(e, 'error');
  }
}

// ============ Config ============

async function loadConfig() {
  try {
    config = await invoke('get_config');

    // Populate fields if we have a saved TV
    if (config.active_tv && config.tvs[config.active_tv]) {
      const tv = config.tvs[config.active_tv];
      document.getElementById('tv-name').value = config.active_tv;
      document.getElementById('tv-ip').value = tv.ip || '';
      document.getElementById('use-ssl').checked = tv.use_ssl !== false;

      // Show MAC address if saved
      const macInput = document.getElementById('mac-input');
      const macStatus = document.getElementById('mac-status');
      if (tv.mac) {
        macInput.value = tv.mac;
        macStatus.textContent = 'MAC saved - Wake-on-LAN ready';
        macStatus.className = 'hint success';
      } else {
        macInput.value = '';
        macStatus.textContent =
          'Not set - fetch while connected or enter manually';
        macStatus.className = 'hint warning';
      }
    }

    // Streaming device
    const sd = config.streaming_device;
    const typeSelect = document.getElementById('streaming-device-type');
    if (sd) {
      if (sd.type === 'wol') {
        typeSelect.value = 'wol';
        document.getElementById('streaming-device-mac').value = sd.mac || '';
        document.getElementById('streaming-device-wol-broadcast').value =
          sd.broadcast_ip || '';
      } else if (sd.type === 'adb') {
        typeSelect.value = 'adb';
        document.getElementById('streaming-device-adb-ip').value = sd.ip || '';
        document.getElementById('streaming-device-adb-port').value = sd.port
          ? String(sd.port)
          : '5555';
      } else if (sd.type === 'roku') {
        typeSelect.value = 'roku';
        document.getElementById('streaming-device-ip').value = sd.ip || '';
      } else {
        typeSelect.value = '';
      }
    } else {
      typeSelect.value = '';
    }
    document.getElementById('wake-streaming-on-power-on').checked =
      config.wake_streaming_on_power_on === true;
    toggleStreamingDeviceFields();
    const wakeStreamingBtn = document.getElementById('wake-streaming-btn');
    if (wakeStreamingBtn)
      wakeStreamingBtn.style.display = config.streaming_device ? '' : 'none';

    // Load shortcut settings
    await loadShortcutSettings();
    await loadActionShortcuts();

    // Load autostart and version
    await loadAutostartSettings();
    await loadVersion();

    // Check if we should auto-connect
    if (config.active_tv && config.tvs[config.active_tv]?.client_key) {
      connectTv();
    } else {
      // Show settings if no TV configured; ensure status shows Connect button if we have connection info
      setStatus(false);
      document.getElementById('settings-panel').classList.remove('collapsed');
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

async function loadShortcutSettings() {
  try {
    const [shortcut, enabled] = await invoke('get_shortcut_settings');
    currentShortcut = shortcut;
    shortcutEnabled = enabled;
    document.getElementById('shortcut-input').value = shortcut;
    document.getElementById('shortcut-enabled').checked = enabled;
  } catch (e) {
    console.error('Failed to load shortcut settings:', e);
  }
}

async function loadVersion() {
  try {
    const version = await invoke('get_app_version');
    document.getElementById('app-version').textContent = `Version ${version}`;
  } catch (e) {
    console.error('Failed to load version:', e);
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
    const dev = await invoke('is_dev');
    const el = document.getElementById('window-size-dev');
    if (!dev || !el) return;
    el.setAttribute('aria-hidden', 'false');
    const update = async () => {
      try {
        // Returns the main window's outer size (total window, including any OS frame).
        const [w, h] = await invoke('get_window_size');
        const innerW = Math.max(0, (w || 0) - OUTER_FRAME_W);
        const innerH = Math.max(0, (h || 0) - OUTER_FRAME_H);
        el.textContent = ` · ${innerW} × ${innerH}`;
      } catch (_) {
        el.textContent = '';
      }
    };
    await update();
    devWindowSizeInterval = setInterval(update, 200);
  } catch (_) {
    // not dev or is_dev not available
  }
}

async function resetWindowSize() {
  try {
    await invoke('reset_window_size');
    showToast('Window size reset to default', 'success');
  } catch (e) {
    showToast(e, 'error');
  }
}

async function loadAutostartSettings() {
  try {
    const enabled = await invoke('get_autostart_enabled');
    document.getElementById('autostart-enabled').checked = enabled;
  } catch (e) {
    console.error('Failed to load autostart setting:', e);
  }
}

async function toggleAutostart() {
  const enabled = document.getElementById('autostart-enabled').checked;
  try {
    await invoke('set_autostart_enabled', { enabled });
    showToast(
      enabled ? 'App will start with your computer' : 'Autostart disabled',
      'success',
    );
  } catch (e) {
    showToast(e, 'error');
    document.getElementById('autostart-enabled').checked = !enabled;
  }
}

async function toggleShortcut() {
  const enabled = document.getElementById('shortcut-enabled').checked;
  const shortcut = document.getElementById('shortcut-input').value.trim();

  if (enabled && !shortcut) {
    showToast('Please set a shortcut first', 'error');
    document.getElementById('shortcut-enabled').checked = false;
    return;
  }

  await saveShortcut(shortcut, enabled);
}

async function saveShortcut(shortcut, enabled) {
  try {
    await invoke('set_shortcut', { shortcut, enabled });
    currentShortcut = shortcut;
    shortcutEnabled = enabled;
    showToast(
      enabled && shortcut
        ? `Shortcut: ${shortcut}`
        : shortcut
          ? 'Shortcut disabled'
          : 'Shortcut cleared',
      'success',
    );
  } catch (e) {
    showToast(e, 'error');
    // Revert UI on error
    document.getElementById('shortcut-input').value = currentShortcut;
    document.getElementById('shortcut-enabled').checked = shortcutEnabled;
  }
}

function clearGlobalShortcut() {
  const input = document.getElementById('shortcut-input');
  input.value = '';
  currentShortcut = '';
  const enabled = document.getElementById('shortcut-enabled').checked;
  saveShortcut('', enabled);
}

// Shortcut recorder
function setupShortcutRecorder() {
  const input = document.getElementById('shortcut-input');
  const hint = document.getElementById('shortcut-hint');

  input.addEventListener('focus', () => {
    isRecordingShortcut = true;
    recordedKeys.clear();
    input.classList.add('recording');
    hint.classList.add('recording');
    hint.textContent = 'Press key combination...';
    input.value = '';
  });

  input.addEventListener('blur', async () => {
    isRecordingShortcut = false;
    input.classList.remove('recording');
    hint.classList.remove('recording');
    hint.textContent = 'Click to record shortcut';

    const newShortcut = input.value.trim();
    if (newShortcut && newShortcut !== currentShortcut) {
      // Save the new shortcut
      const enabled = document.getElementById('shortcut-enabled').checked;
      await saveShortcut(newShortcut, enabled);
    } else if (!newShortcut) {
      // Restore previous shortcut if nothing recorded
      input.value = currentShortcut;
    }

    recordedKeys.clear();
  });

  input.addEventListener('keydown', (e) => {
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

  input.addEventListener('keyup', (e) => {
    if (!isRecordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();
  });
}

function mapKeyToTauri(e) {
  // Modifiers
  if (e.key === 'Control') return 'Ctrl';
  if (e.key === 'Alt') return 'Alt';
  if (e.key === 'Shift') return 'Shift';
  if (e.key === 'Meta' || e.key === 'Super') return 'Super';

  // Space (e.key is ' ') — must be before regular keys
  if (e.key === ' ') return 'Space';

  // Regular keys
  if (e.key.length === 1) {
    return e.key.toUpperCase();
  }

  // Special keys
  const specialKeys = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    F1: 'F1',
    F2: 'F2',
    F3: 'F3',
    F4: 'F4',
    F5: 'F5',
    F6: 'F6',
    F7: 'F7',
    F8: 'F8',
    F9: 'F9',
    F10: 'F10',
    F11: 'F11',
    F12: 'F12',
  };

  return specialKeys[e.key] || null;
}

function updateShortcutDisplay(input) {
  // Order: Super, Ctrl, Alt, Shift, then other keys
  const modOrder = ['Super', 'Ctrl', 'Alt', 'Shift'];
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

  const shortcut = [...mods, ...keys].join('+');
  input.value = shortcut;
}

function buildShortcutFromKeys(keysSet) {
  const modOrder = ['Super', 'Ctrl', 'Alt', 'Shift'];
  const mods = [];
  const keys = [];
  for (const key of keysSet) {
    if (modOrder.includes(key)) mods.push(key);
    else keys.push(key);
  }
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
  return [...mods, ...keys].join('+');
}

function eventToShortcutString(e) {
  const keys = new Set();
  if (e.metaKey) keys.add('Super');
  if (e.ctrlKey) keys.add('Ctrl');
  if (e.altKey) keys.add('Alt');
  if (e.shiftKey) keys.add('Shift');
  const key = mapKeyToTauri(e);
  if (key) keys.add(key);
  return buildShortcutFromKeys(keys);
}

/** Build the set of keys (for recording) from a single keydown: current modifiers + the key. */
function eventToKeySet(e) {
  const keys = new Set();
  if (e.metaKey) keys.add('Super');
  if (e.ctrlKey) keys.add('Ctrl');
  if (e.altKey) keys.add('Alt');
  if (e.shiftKey) keys.add('Shift');
  const key = mapKeyToTauri(e);
  if (key) keys.add(key);
  return keys;
}

// ============ Action Shortcuts ============

function buildShortcutToActionMap() {
  shortcutToAction = {};
  for (const [id, ac] of Object.entries(actionShortcuts)) {
    if (ac.shortcut && ac.shortcut.trim()) {
      shortcutToAction[ac.shortcut.trim()] = id;
    }
  }
}

async function loadActionShortcuts() {
  try {
    const loaded = await invoke('get_action_shortcuts');
    actionShortcuts = {};
    for (const a of ACTIONS) {
      const c = loaded[a.id];
      actionShortcuts[a.id] = {
        shortcut: c && c.shortcut != null ? c.shortcut : a.defaultShortcut,
        global: c && c.global != null ? c.global : false,
      };
    }
    buildShortcutToActionMap();
    renderShortcutsList();
    setupActionShortcutRecorders();
  } catch (e) {
    console.error('Failed to load action shortcuts:', e);
  }
}

function renderShortcutsList() {
  const list = document.getElementById('shortcuts-list');
  list.innerHTML = '';
  for (const a of ACTIONS) {
    const ac = actionShortcuts[a.id] || {
      shortcut: a.defaultShortcut,
      global: false,
    };
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.dataset.actionId = a.id;
    row.innerHTML = `
      <label class="shortcut-label">${escapeHtml(a.label)}</label>
      <input type="text" class="shortcut-input-action" data-action-id="${escapeHtml(a.id)}" value="${escapeHtml(ac.shortcut)}" placeholder="Click and press keys..." readonly>
      <button type="button" class="btn-clear-shortcut" data-action-id="${escapeHtml(a.id)}" title="Clear shortcut; click when empty to reset to default" aria-label="Clear shortcut; click when empty to reset to default">&times;</button>
      <label class="shortcut-global-label">
        <input type="checkbox" class="shortcut-global-cb" data-action-id="${escapeHtml(a.id)}" ${ac.global ? 'checked' : ''}>
        Global
      </label>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('.shortcut-global-cb').forEach((cb) => {
    cb.addEventListener('change', onActionGlobalChange);
  });
  list.querySelectorAll('.btn-clear-shortcut').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.dataset.actionId;
      if (!id || !actionShortcuts[id]) return;
      const row = e.target.closest('.shortcut-row');
      const input = row?.querySelector('.shortcut-input-action');
      const cb = row?.querySelector('.shortcut-global-cb');
      const isEmpty = !input?.value?.trim();
      if (isEmpty) {
        const action = ACTIONS.find((a) => a.id === id);
        const defaultShortcut = action ? action.defaultShortcut : '';
        actionShortcuts[id].shortcut = defaultShortcut;
        actionShortcuts[id].global = false;
        if (input) input.value = defaultShortcut;
        if (cb) cb.checked = false;
        showToast('Reset to default', 'success');
      } else {
        actionShortcuts[id].shortcut = '';
        actionShortcuts[id].global = false;
        if (input) input.value = '';
        if (cb) cb.checked = false;
      }
      buildShortcutToActionMap();
      saveActionShortcuts();
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
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
  document.querySelectorAll('.shortcut-row').forEach((row) => {
    const id = row.dataset.actionId;
    const input = row.querySelector('.shortcut-input-action');
    const cb = row.querySelector('.shortcut-global-cb');
    if (id && actionShortcuts[id]) {
      if (input) actionShortcuts[id].shortcut = input.value.trim();
      if (cb) actionShortcuts[id].global = cb.checked;
    }
  });
}

async function saveActionShortcuts() {
  collectActionShortcutsFromDOM();
  try {
    await invoke('set_action_shortcuts', { shortcuts: actionShortcuts });
    buildShortcutToActionMap();
    showToast('Shortcuts saved', 'success');
  } catch (e) {
    showToast(e, 'error');
  }
}

function setupActionShortcutRecorders() {
  document.querySelectorAll('.shortcut-input-action').forEach((input) => {
    const actionId = input.dataset.actionId;
    input.addEventListener('focus', () => {
      isRecordingActionShortcut = actionId;
      recordedActionKeys.clear();
      input.classList.add('recording');
      input.value = '';
    });
    input.addEventListener('blur', async () => {
      isRecordingActionShortcut = null;
      input.classList.remove('recording');
      const newShortcut = input.value.trim();
      if (actionShortcuts[actionId]) {
        actionShortcuts[actionId].shortcut = newShortcut;
        buildShortcutToActionMap();
        await saveActionShortcuts();
      }
      if (!newShortcut && ACTIONS.find((a) => a.id === actionId)) {
        input.value = ACTIONS.find((a) => a.id === actionId).defaultShortcut;
        if (actionShortcuts[actionId]) {
          actionShortcuts[actionId].shortcut = input.value;
          await saveActionShortcuts();
        }
      }
      recordedActionKeys.clear();
    });
    input.addEventListener('keydown', (e) => {
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
    input.addEventListener('keyup', (e) => {
      if (isRecordingActionShortcut === actionId) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  });
}

async function runAction(actionId) {
  switch (actionId) {
    case 'up':
      return sendButton('UP');
    case 'down':
      return sendButton('DOWN');
    case 'left':
      return sendButton('LEFT');
    case 'right':
      return sendButton('RIGHT');
    case 'enter':
      return sendButton('ENTER');
    case 'back':
      return sendButton('BACK');
    case 'play':
      return sendButton('PLAY');
    case 'pause':
      return sendButton('PAUSE');
    case 'stop':
      return sendButton('STOP');
    case 'fast_forward':
      return sendButton('FAST_FORWARD');
    case 'rewind':
      return sendButton('REWIND');
    case 'volume_up':
      return volumeUp();
    case 'volume_down':
      return volumeDown();
    case 'mute':
      return setMute(true);
    case 'unmute':
      return setMute(false);
    case 'power_on':
      return powerOn();
    case 'power_off':
      return powerOff();
    case 'wake_streaming_device':
      return wakeStreamingDevice();
    case 'home':
      return sendButton('HOME');
    default:
      return Promise.resolve();
  }
}

// ============ Keyboard Shortcuts ============

document.addEventListener('keydown', (e) => {
  if (
    e.target.tagName === 'INPUT' ||
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
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn')) {
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
    const connected = await invoke('get_status');
    if (isConnected && !connected) {
      // We thought we were connected but we're not (e.g. connection dropped
      // while window was hidden on Windows). Auto-reconnect if we have creds.
      setStatus(false, 'Disconnected');
      if (hasConnectionInfo()) {
        connectTv();
      }
    } else if (!isConnected && connected) {
      // Backend says connected
      setStatus(true, 'Connected');
    }
  } catch (e) {
    console.error('Status check failed:', e);
  }
}

// ============ Init ============

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  setupShortcutRecorder();
  listenRunCommand();
  listenConnectionLost();
});

function listenRunCommand() {
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('run-command', (e) => {
      const actionId = e.payload;
      if (actionId && typeof runAction === 'function') {
        runAction(actionId);
      }
    });
  }
}

// When keepalive detects connection dropped in background, sync UI
function listenConnectionLost() {
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('connection-lost', () => {
      setStatus(false, 'Disconnected');
    });
  }
}

// Check status when window becomes visible (user clicked tray icon)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkStatus();
  }
  // Pause dev window size polling when hidden to avoid unnecessary invokes
  const el = document.getElementById('window-size-dev');
  if (el && el.textContent) {
    if (document.visibilityState === 'hidden' && devWindowSizeInterval) {
      clearInterval(devWindowSizeInterval);
      devWindowSizeInterval = null;
    } else if (
      document.visibilityState === 'visible' &&
      !devWindowSizeInterval
    ) {
      startDevWindowSize();
    }
  }
});
