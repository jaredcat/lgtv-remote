// Tauri API is injected globally via withGlobalTauri in tauri.conf.json
const invoke = window.__TAURI__.core.invoke;

// ============ State ============
let isConnected = false;
let config = null;
let shortcutEnabled = false;
let currentShortcut = '';
let isRecordingShortcut = false;
let recordedKeys = new Set();

// ============ UI Helpers ============

function hasConnectionInfo() {
  return Boolean(config && config.active_tv && config.tvs?.[config.active_tv]?.client_key);
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

function buttonFeedback(element) {
  element.classList.add('active');
  setTimeout(() => element.classList.remove('active'), 100);
}

// ============ TV Commands ============

// Check if error indicates we are no longer connected (single source of truth for UI)
function isDisconnectError(error) {
  const msg = String(error).toLowerCase();
  return msg.includes('disconnected') ||
         msg.includes('not connected') ||
         msg.includes('connection closed') ||
         msg.includes('timeout') ||
         msg.includes('send failed') ||
         msg.includes('websocket error');
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
        macStatus.textContent = 'Not set - fetch while connected or enter manually';
        macStatus.className = 'hint warning';
      }
    }
    
    // Load shortcut settings
    await loadShortcutSettings();
    
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
    showToast(enabled ? `Shortcut: ${shortcut}` : 'Shortcut disabled', 'success');
  } catch (e) {
    showToast(e, 'error');
    // Revert UI on error
    document.getElementById('shortcut-input').value = currentShortcut;
    document.getElementById('shortcut-enabled').checked = shortcutEnabled;
  }
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
    
    // Map key to Tauri format
    const key = mapKeyToTauri(e);
    if (key) {
      recordedKeys.add(key);
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
  
  // Regular keys
  if (e.key.length === 1) {
    return e.key.toUpperCase();
  }
  
  // Special keys
  const specialKeys = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Enter': 'Return',
    'Escape': 'Escape',
    'Tab': 'Tab',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'Insert': 'Insert',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
    'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
    'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
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

// ============ Keyboard Shortcuts ============

document.addEventListener('keydown', (e) => {
  // Don't capture when typing in inputs or recording shortcuts
  if (e.target.tagName === 'INPUT' || isRecordingShortcut) return;
  
  const hasShift = e.shiftKey;
  
  switch (e.key) {
    case 'ArrowUp':
      sendButton('UP');
      e.preventDefault();
      break;
    case 'ArrowDown':
      sendButton('DOWN');
      e.preventDefault();
      break;
    case 'ArrowLeft':
      sendButton('LEFT');
      e.preventDefault();
      break;
    case 'ArrowRight':
      sendButton('RIGHT');
      e.preventDefault();
      break;
    case 'Enter':
      sendButton('ENTER');
      e.preventDefault();
      break;
    case 'Backspace':
    case 'Escape':
      sendButton('BACK');
      e.preventDefault();
      break;
    case '=':
    case '+':
      if (hasShift) {
        setMute(false);
      } else {
        volumeUp();
      }
      e.preventDefault();
      break;
    case '-':
    case '_':
      if (hasShift) {
        setMute(true);
      } else {
        volumeDown();
      }
      e.preventDefault();
      break;
  }
});

// Add click feedback to all buttons
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn')) {
    buttonFeedback(e.target);
  }
});

// ============ Status Check ============

// Check actual connection status from backend
async function checkStatus() {
  try {
    const connected = await invoke('get_status');
    if (isConnected && !connected) {
      // We thought we were connected but we're not
      setStatus(false, 'Disconnected');
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
});

// Check status when window becomes visible (user clicked tray icon)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkStatus();
  }
});
