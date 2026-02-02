// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tv;

use config::{ActionShortcutConfig, Config, StreamingDeviceConfig, TvConfig, WindowSize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::Mutex;
use tv::{CommandResult, TvConnection};

#[cfg(feature = "autostart")]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(all(feature = "autostart", target_os = "linux"))]
use auto_launch::LinuxLaunchMode;

// Track window visibility ourselves since is_visible() can be unreliable
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(false);

// When true, cancel the pending hide scheduled on Focused(false) (e.g. user is resizing).
#[cfg(target_os = "windows")]
static CANCEL_PENDING_HIDE: AtomicBool = AtomicBool::new(false);

/// On Windows with decorations: false, the OS adds ~16×9 to inner size to get outer.
/// We store inner size in config so set_size(saved) reproduces the same window.
#[cfg(target_os = "windows")]
const OUTER_FRAME_W: u32 = 16;
#[cfg(target_os = "windows")]
const OUTER_FRAME_H: u32 = 9;
#[cfg(not(target_os = "windows"))]
const OUTER_FRAME_W: u32 = 0;
#[cfg(not(target_os = "windows"))]
const OUTER_FRAME_H: u32 = 0;

fn outer_to_inner_size(outer_w: u32, outer_h: u32) -> (u32, u32) {
    (
        outer_w.saturating_sub(OUTER_FRAME_W),
        outer_h.saturating_sub(OUTER_FRAME_H),
    )
}

struct AppState {
    tv: Mutex<TvConnection>,
    config: Mutex<Config>,
}

// ============ Tauri Commands ============

#[tauri::command]
async fn get_config(state: tauri::State<'_, Arc<AppState>>) -> Result<Config, String> {
    let config = state.config.lock().await;
    Ok(config.clone())
}

#[tauri::command]
async fn save_tv(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    ip: String,
    use_ssl: bool,
) -> Result<(), String> {
    let mut config = state.config.lock().await;
    config.set_tv(
        name,
        TvConfig {
            ip,
            use_ssl,
            client_key: None,
            mac: None,
        },
    );
    config.save()
}

#[tauri::command]
async fn set_active_tv(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    let mut config = state.config.lock().await;
    if config.tvs.contains_key(&name) {
        config.active_tv = Some(name);
        config.save()
    } else {
        Err("TV not found".to_string())
    }
}

/// Spawns a background task that pings the TV every 25s while connected.
/// Never stops pinging until connection is dropped or disconnected.
/// Emits "connection-lost" to the frontend when keepalive detects a dead connection.
fn spawn_keepalive(state: Arc<AppState>, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(25));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let mut tv = state.tv.lock().await;
            if !tv.connected {
                log::debug!("Keepalive: exiting (not connected)");
                break;
            }
            log::debug!("Keepalive: sending ping");
            match tv.keepalive_ping().await {
                Ok(()) => {
                    log::debug!("Keepalive: ok");
                    // Refresh input socket (d-pad, enter, back, etc.) so it doesn't go stale;
                    // the TV can close it while the main SSAP socket stays open.
                    log::debug!("Keepalive: refreshing input socket");
                    match tv.refresh_input_socket().await {
                        Ok(()) => log::debug!("Keepalive: input socket refreshed"),
                        Err(e) => {
                            log::warn!("Keepalive: refresh input socket failed: {} (retrying in 3s)", e);
                            drop(tv);
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            let mut tv = state.tv.lock().await;
                            if tv.connected {
                                if let Err(e2) = tv.refresh_input_socket().await {
                                    log::warn!("Keepalive: refresh input socket failed again: {} (will retry next cycle)", e2);
                                } else {
                                    log::debug!("Keepalive: input socket refreshed on retry");
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Keepalive failed, connection dropped: {}", e);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("connection-lost", ());
                    }
                    break;
                }
            }
        }
    });
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CommandResult, String> {
    let config = state.config.lock().await;
    let (name, tv_config) = config
        .get_active_tv()
        .ok_or("No TV configured")?;

    let name = name.clone();
    let ip = tv_config.ip.clone();
    let client_key = tv_config.client_key.clone();
    let use_ssl = tv_config.use_ssl;
    drop(config);

    let mut tv = state.tv.lock().await;
    let result = tv
        .connect(&name, &ip, client_key.as_deref(), use_ssl)
        .await?;

    // Save new client key if returned
    if let Some(ref key) = result.client_key {
        let mut config = state.config.lock().await;
        config.update_client_key(&name, key.clone());
        let _ = config.save();
    }

    spawn_keepalive(state.inner().clone(), app);
    Ok(result)
}

#[tauri::command]
async fn authenticate(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    ip: String,
    use_ssl: bool,
) -> Result<CommandResult, String> {
    // First save the TV
    {
        let mut config = state.config.lock().await;
        config.set_tv(
            name.clone(),
            TvConfig {
                ip: ip.clone(),
                use_ssl,
                client_key: None,
                mac: None,
            },
        );
        config.active_tv = Some(name.clone());
        config.save()?;
    }

    // Connect (will prompt for pairing on TV)
    let mut tv = state.tv.lock().await;
    let result = tv.connect(&name, &ip, None, use_ssl).await?;

    // Save client key and try to get MAC
    if let Some(ref key) = result.client_key {
        let mut config = state.config.lock().await;
        config.update_client_key(&name, key.clone());

        // Try to get MAC address for Wake-on-LAN
        // We need the MAC of the connected interface (wifi or wired)
        match tv.get_connected_mac().await {
            Ok(Some(mac)) => {
                log::info!("Saved MAC address: {}", mac);
                config.update_mac(&name, mac);
            }
            Ok(None) => {
                log::warn!("Could not find MAC address in network info");
            }
            Err(e) => {
                log::warn!("Failed to get MAC address: {}", e);
            }
        }

        config.save()?;
    }

    spawn_keepalive(state.inner().clone(), app);
    Ok(result)
}

#[tauri::command]
async fn disconnect(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut tv = state.tv.lock().await;
    tv.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn get_status(state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let tv = state.tv.lock().await;
    Ok(tv.connected)
}

#[tauri::command]
async fn send_button(
    state: tauri::State<'_, Arc<AppState>>,
    button: String,
) -> Result<CommandResult, String> {
    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected".to_string());
    }
    tv.send_button(&button).await
}

#[tauri::command]
async fn volume_up(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected".to_string());
    }
    tv.volume_up().await
}

#[tauri::command]
async fn volume_down(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected".to_string());
    }
    tv.volume_down().await
}

#[tauri::command]
async fn set_mute(
    state: tauri::State<'_, Arc<AppState>>,
    mute: bool,
) -> Result<CommandResult, String> {
    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected".to_string());
    }
    tv.set_mute(mute).await
}

#[tauri::command]
async fn power_off(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected".to_string());
    }
    tv.power_off().await
}

#[tauri::command]
async fn power_on(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let (mac, wake_streaming, streaming_device) = {
        let config = state.config.lock().await;
        let (_, tv_config) = config.get_active_tv().ok_or("No TV configured")?;
        let mac = tv_config
            .mac
            .as_ref()
            .ok_or("MAC address not saved. Connect to the TV while it's on and click 'Fetch MAC', or set it manually in settings.")?
            .clone();
        let wake_streaming = config.wake_streaming_on_power_on;
        let streaming_device = config.streaming_device.clone();
        (mac, wake_streaming, streaming_device)
    };

    let result = tv::wake_on_lan(&mac, None)?;
    if wake_streaming {
        if let Some(device) = streaming_device {
            let _ = wake_streaming_device_impl(&device).await;
        }
    }
    Ok(result)
}

#[tauri::command]
async fn fetch_mac(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let config = state.config.lock().await;
    let (name, _) = config.get_active_tv().ok_or("No TV configured")?;
    let name = name.clone();
    drop(config);

    let mut tv = state.tv.lock().await;
    if !tv.connected {
        return Err("Not connected. Connect to the TV first.".to_string());
    }

    // Get MAC of the connected interface (wifi or wired)
    match tv.get_connected_mac().await {
        Ok(Some(mac)) => {
            let mut config = state.config.lock().await;
            config.update_mac(&name, mac.clone());
            config.save()?;
            Ok(CommandResult::ok_with_message(&format!("MAC address saved: {}", mac)))
        }
        Ok(None) => {
            Err("Could not find MAC address in TV response. Please enter manually.".to_string())
        }
        Err(e) => {
            Err(format!("Failed to get MAC address: {}. Please enter manually.", e))
        }
    }
}

#[tauri::command]
async fn set_mac(
    state: tauri::State<'_, Arc<AppState>>,
    mac: String,
) -> Result<CommandResult, String> {
    // Validate MAC format (basic check)
    let mac_clean = mac.replace([':', '-', ' '], "");
    if mac_clean.len() != 12 || !mac_clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid MAC address format. Use format like AA:BB:CC:DD:EE:FF or AABBCCDDEEFF".to_string());
    }

    let mut config = state.config.lock().await;
    let (name, _) = config.get_active_tv().ok_or("No TV configured")?;
    let name = name.clone();

    // Normalize to colon-separated format
    let mac_formatted = mac_clean
        .as_bytes()
        .chunks(2)
        .map(|chunk| std::str::from_utf8(chunk).unwrap())
        .collect::<Vec<_>>()
        .join(":");

    config.update_mac(&name, mac_formatted.clone());
    config.save()?;

    Ok(CommandResult::ok_with_message(&format!("MAC address set to: {}", mac_formatted)))
}

async fn wake_streaming_device_impl(device: &StreamingDeviceConfig) -> Result<CommandResult, String> {
    match device {
        StreamingDeviceConfig::Wol { mac, broadcast_ip } => {
            tv::wake_on_lan(mac, broadcast_ip.as_deref())
        }
        StreamingDeviceConfig::Adb { ip, port } => {
            tv::wake_adb(ip, port.unwrap_or(5555)).await
        }
        StreamingDeviceConfig::Roku { ip } => tv::wake_roku(ip).await,
    }
}

#[tauri::command]
async fn wake_streaming_device(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
    let config = state.config.lock().await;
    let device = config
        .streaming_device
        .as_ref()
        .ok_or("No streaming device configured. Add one in Settings (e.g. Android TV / Shield MAC for Wake-on-LAN, or Roku IP).")?
        .clone();
    drop(config);
    wake_streaming_device_impl(&device).await
}

#[tauri::command]
async fn set_streaming_device(
    state: tauri::State<'_, Arc<AppState>>,
    device: Option<StreamingDeviceConfig>,
) -> Result<(), String> {
    let mut config = state.config.lock().await;
    config.set_streaming_device(device);
    config.save()
}

#[tauri::command]
async fn set_wake_streaming_on_power_on(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let mut config = state.config.lock().await;
    config.wake_streaming_on_power_on = enabled;
    config.save()
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// On Linux (e.g. NixOS), when set, use this as the Exec path for autostart instead of the
/// current executable. Use a stable path or command name (e.g. `lgtv-tray-remote`) so autostart
/// keeps working across package version updates. Unset on other platforms.
#[cfg(target_os = "linux")]
const AUTOSTART_EXEC_ENV: &str = "TAURI_AUTOSTART_EXEC";

#[cfg(feature = "autostart")]
#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    if let Ok(exec) = std::env::var(AUTOSTART_EXEC_ENV) {
        if !exec.is_empty() {
            let name = app.config().identifier.as_str();
            let auto = auto_launch::AutoLaunch::new(
                name,
                &exec,
                LinuxLaunchMode::XdgAutostart,
                &[] as &[&str],
            );
            return auto.is_enabled().map_err(|e| e.to_string());
        }
    }
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(feature = "autostart")]
#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Ok(exec) = std::env::var(AUTOSTART_EXEC_ENV) {
        if !exec.is_empty() {
            let name = app.config().identifier.as_str();
            let auto = auto_launch::AutoLaunch::new(
                name,
                &exec,
                LinuxLaunchMode::XdgAutostart,
                &[] as &[&str],
            );
            return if enabled {
                auto.enable().map_err(|e| e.to_string())
            } else {
                auto.disable().map_err(|e| e.to_string())
            };
        }
    }
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[cfg(not(feature = "autostart"))]
#[tauri::command]
fn get_autostart_enabled(_app: tauri::AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(feature = "autostart"))]
#[tauri::command]
fn set_autostart_enabled(_app: tauri::AppHandle, _enabled: bool) -> Result<(), String> {
    Err("Autostart is not available in this build".to_string())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// True when built with `cargo tauri dev` (debug profile).
#[tauri::command]
fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Current main window outer size in physical pixels. For dev UI.
#[tauri::command]
fn get_window_size(app: tauri::AppHandle) -> Result<(u32, u32), String> {
    app.get_webview_window("main")
        .and_then(|w| w.outer_size().ok())
        .map(|s| (s.width, s.height))
        .ok_or_else(|| "Window not available".to_string())
}

#[tauri::command]
async fn reset_window_size(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().await;
        config.window_size = None;
        config.save()?;
    }
    // Use default size from tauri.conf.json (app.windows[0]). Use Logical size so the window
    // has the same apparent size on all displays (e.g. Retina 2x vs 1x); Physical would make
    // the window look tiny on high-DPI Macs.
    let (width, height) = app
        .config()
        .app
        .windows
        .first()
        .map(|w| (w.width as f64, w.height as f64))
        .unwrap_or((375.0, 525.0));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
    }
    Ok(())
}

#[tauri::command]
async fn get_shortcut_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<(String, bool), String> {
    let config = state.config.lock().await;
    Ok((config.global_shortcut.clone(), config.shortcut_enabled))
}

#[tauri::command]
async fn set_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    shortcut: String,
    enabled: bool,
) -> Result<(), String> {
    if enabled && !shortcut.is_empty() {
        shortcut.parse::<Shortcut>().map_err(|e| {
            format!(
                "Invalid shortcut '{}': {}. Use modifiers first and only one main key (e.g. Shift+Alt+K)",
                shortcut, e
            )
        })?;
        if !shortcut_has_modifier(&shortcut) {
            return Err(
                "Global shortcut must include a modifier (Ctrl, Alt, Shift, or Super) so it doesn't capture keys during normal typing.".to_string()
            );
        }
    }
    {
        let mut config = state.config.lock().await;
        config.global_shortcut = shortcut.clone();
        config.shortcut_enabled = enabled;
        config.save()?;
    }
    register_all_global_shortcuts(&app)?;
    Ok(())
}

#[tauri::command]
async fn get_action_shortcuts(state: tauri::State<'_, Arc<AppState>>) -> Result<HashMap<String, ActionShortcutConfig>, String> {
    let config = state.config.lock().await;
    Ok(config.action_shortcuts.clone())
}

#[tauri::command]
async fn set_action_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    shortcuts: HashMap<String, ActionShortcutConfig>,
) -> Result<(), String> {
    // Validate: any shortcut with global=true must have a modifier
    let missing: Vec<String> = shortcuts
        .iter()
        .filter(|(_, ac)| ac.global && !ac.shortcut.trim().is_empty())
        .filter(|(_, ac)| !shortcut_has_modifier(&ac.shortcut))
        .map(|(id, _)| id.clone())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Global shortcuts must include a modifier (Ctrl, Alt, Shift, or Super): {}",
            missing.join(", ")
        ));
    }
    {
        let mut config = state.config.lock().await;
        config.action_shortcuts = shortcuts;
        config.save()?;
    }
    register_all_global_shortcuts(&app)?;
    Ok(())
}

/// Run an action by id (used for global shortcuts so they work when window is hidden).
async fn run_action_impl(state: Arc<AppState>, action_id: &str) -> Result<(), String> {
    let mut tv = state.tv.lock().await;
    match action_id {
        "up" => tv.send_button("UP").await.map(|_| ()),
        "down" => tv.send_button("DOWN").await.map(|_| ()),
        "left" => tv.send_button("LEFT").await.map(|_| ()),
        "right" => tv.send_button("RIGHT").await.map(|_| ()),
        "enter" => tv.send_button("ENTER").await.map(|_| ()),
        "back" => tv.send_button("BACK").await.map(|_| ()),
        "volume_up" => tv.volume_up().await.map(|_| ()),
        "volume_down" => tv.volume_down().await.map(|_| ()),
        "mute" => tv.set_mute(true).await.map(|_| ()),
        "unmute" => tv.set_mute(false).await.map(|_| ()),
        "power_off" => tv.power_off().await.map(|_| ()),
        "home" => tv.send_button("HOME").await.map(|_| ()),
        "power_on" => {
            drop(tv);
            let config = state.config.lock().await;
            let (_, tv_config) = config.get_active_tv().ok_or("No TV configured")?;
            let mac = tv_config
                .mac
                .as_ref()
                .ok_or("MAC address not saved")?
                .clone();
            drop(config);
            tv::wake_on_lan(&mac, None).map(|_| ())
        }
        "wake_streaming_device" => {
            drop(tv);
            let config = state.config.lock().await;
            let device = config
                .streaming_device
                .clone()
                .ok_or("No streaming device configured")?;
            drop(config);
            wake_streaming_device_impl(&device).await.map(|_| ())
        }
        _ => Ok(()),
    }
}

/// Modifier key names (case-insensitive). Global hotkeys must include at least one
/// so they don't capture keys during normal typing.
const GLOBAL_MODIFIERS: &[&str] = &["ctrl", "control", "alt", "shift", "super", "command", "meta"];

fn shortcut_has_modifier(s: &str) -> bool {
    s.split('+')
        .map(|p| p.trim().to_lowercase())
        .any(|p| GLOBAL_MODIFIERS.contains(&p.as_str()))
}

/// Registers the toggle-window shortcut and all action shortcuts that have global=true.
fn register_all_global_shortcuts(app: &AppHandle) -> Result<(), String> {
    let config = Config::load();
    let manager = app.global_shortcut();
    manager.unregister_all().map_err(|e| e.to_string())?;

    // 1. Toggle-window shortcut (skip if invalid so saving action shortcuts doesn't fail)
    if config.shortcut_enabled && !config.global_shortcut.is_empty() {
        if shortcut_has_modifier(&config.global_shortcut)
            && let Ok(shortcut) = config.global_shortcut.parse::<Shortcut>()
        {
            let app_handle = app.clone();
            if let Err(e) = manager.on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state != ShortcutState::Released {
                    return;
                }
                if let Some(window) = app_handle.get_webview_window("main") {
                    let currently_visible = WINDOW_VISIBLE.load(Ordering::SeqCst);
                    if currently_visible {
                        let _ = window.hide();
                        WINDOW_VISIBLE.store(false, Ordering::SeqCst);
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                        WINDOW_VISIBLE.store(true, Ordering::SeqCst);
                    }
                }
            }) {
                log::warn!("Failed to register toggle shortcut: {}", e);
            }
        } else if !shortcut_has_modifier(&config.global_shortcut) {
            log::warn!(
                "Toggle shortcut '{}' has no modifier; global shortcut not registered",
                config.global_shortcut
            );
        } else {
            log::warn!(
                "Invalid toggle shortcut '{}': modifiers first and only one main key (e.g. Shift+Alt+K)",
                config.global_shortcut
            );
        }
    }

    // 2. Action shortcuts (global hotkeys that run a command)
    for (action_id, ac) in &config.action_shortcuts {
        if !ac.global || ac.shortcut.is_empty() || !shortcut_has_modifier(&ac.shortcut) {
            if ac.global && !ac.shortcut.is_empty() && !shortcut_has_modifier(&ac.shortcut) {
                log::warn!(
                    "Action shortcut '{}' for {} has no modifier; not registered as global",
                    ac.shortcut, action_id
                );
            }
            continue;
        }
        let shortcut: Shortcut = match ac.shortcut.parse() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("Invalid action shortcut '{}' for {}: {}", ac.shortcut, action_id, e);
                continue;
            }
        };
        let action_id_emit = action_id.clone();
        let action_id_run = action_id.clone();
        let app_handle = app.clone();
        if let Err(e) = manager.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Released {
                return;
            }
            // Run action in Rust so it works when window is hidden
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                let state = state.inner().clone();
                let action_id = action_id_run.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = run_action_impl(state, &action_id).await {
                        log::warn!("Global shortcut action {} failed: {}", action_id, e);
                    }
                });
            }
            // Also emit to frontend so UI can update when window is visible
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("run-command", &action_id_emit);
            }
        }) {
            log::warn!("Failed to register action shortcut {}: {}", action_id, e);
        }
    }

    Ok(())
}

// ============ Window Positioning ============

fn position_window_near_tray(window: &WebviewWindow, x: f64, y: f64) {
    let window_size = window.outer_size().unwrap_or_default();

    // Get monitor info
    if let Some(monitor) = window.current_monitor().ok().flatten() {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();

        // Calculate position - try to position below/beside the click point
        let mut pos_x = x as i32 - (window_size.width as i32 / 2);
        let mut pos_y = y as i32;

        // Keep window on screen
        let right_edge = monitor_pos.x + monitor_size.width as i32;
        let bottom_edge = monitor_pos.y + monitor_size.height as i32;

        if pos_x + window_size.width as i32 > right_edge {
            pos_x = right_edge - window_size.width as i32;
        }
        if pos_x < monitor_pos.x {
            pos_x = monitor_pos.x;
        }

        // If clicking near bottom (tray), show window above
        if pos_y + window_size.height as i32 > bottom_edge {
            pos_y = y as i32 - window_size.height as i32;
        }
        if pos_y < monitor_pos.y {
            pos_y = monitor_pos.y;
        }

        let _ = window.set_position(PhysicalPosition::new(pos_x, pos_y));
    }
}

fn toggle_window(app: &AppHandle, x: f64, y: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let currently_visible = WINDOW_VISIBLE.load(Ordering::SeqCst);
        if currently_visible {
            let _ = window.hide();
            WINDOW_VISIBLE.store(false, Ordering::SeqCst);
        } else {
            position_window_near_tray(&window, x, y);
            let _ = window.show();
            let _ = window.set_focus();
            WINDOW_VISIBLE.store(true, Ordering::SeqCst);
        }
    }
}

// ============ Main ============

fn main() {
    env_logger::init();

    let state = Arc::new(AppState {
        tv: Mutex::new(TvConnection::new()),
        config: Mutex::new(Config::load()),
    });

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(feature = "autostart")]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
    ));

    // mut required on macOS for set_activation_policy() after build; allow on other platforms to avoid warning
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut app = builder
        .manage(state.clone())
        .setup(|app| {
            // Hide window on startup - we're a tray app
            if let Some(window) = app.get_webview_window("main") {
                // Apply saved window size
                let config = Config::load();
                if let Some(size) = config.window_size {
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: size.height,
                    }));
                }

                let _ = window.hide();
                WINDOW_VISIBLE.store(false, Ordering::SeqCst);

                // Handle window events
                let window_clone = window.clone();
                let _app_handle = app.app_handle().clone();
                window.on_window_event(move |event| {
                    match event {
                        // On Windows, clicking X sends CloseRequested and destroys the window
                        // (losing the TV connection). Prevent close and hide instead so the
                        // app and connection stay alive; user can reopen from tray.
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = window_clone.hide();
                            WINDOW_VISIBLE.store(false, Ordering::SeqCst);
                        }
                        // Hide when focus is lost (e.g. user clicked outside). On Windows, use a
                        // short delay and cancel if the window gets focus back or Resized/Moved.
                        tauri::WindowEvent::Focused(false) => {
                            #[cfg(target_os = "windows")]
                            {
                                CANCEL_PENDING_HIDE.store(false, Ordering::SeqCst);
                                let w = window_clone.clone();
                                let a = _app_handle.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(std::time::Duration::from_millis(200));
                                    if !CANCEL_PENDING_HIDE.load(Ordering::SeqCst) {
                                        let _ = a.run_on_main_thread(move || {
                                            let _ = w.hide();
                                            WINDOW_VISIBLE.store(false, Ordering::SeqCst);
                                        });
                                    }
                                });
                            }
                            #[cfg(not(target_os = "windows"))]
                            {
                                let _ = window_clone.hide();
                                WINDOW_VISIBLE.store(false, Ordering::SeqCst);
                            }
                        }
                        tauri::WindowEvent::Focused(true) => {
                            #[cfg(target_os = "windows")]
                            CANCEL_PENDING_HIDE.store(true, Ordering::SeqCst);
                        }
                        tauri::WindowEvent::Resized(size) => {
                            #[cfg(target_os = "windows")]
                            CANCEL_PENDING_HIDE.store(true, Ordering::SeqCst);
                            // Save inner size so set_size(saved) reproduces the same outer size
                            if size.width > 0 && size.height > 0 {
                                let (w, h) = outer_to_inner_size(size.width, size.height);
                                let mut config = Config::load();
                                config.window_size = Some(WindowSize { width: w, height: h });
                                let _ = config.save();
                            }
                        }
                        tauri::WindowEvent::Moved(_) => {
                            #[cfg(target_os = "windows")]
                            CANCEL_PENDING_HIDE.store(true, Ordering::SeqCst);
                        }
                        _ => {}
                    }
                });
            }

            // Build tray menu (required for KDE/SNI to show the icon)
            let show = MenuItemBuilder::with_id("show", "Open Remote").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            // Create tray icon
            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("Failed to load tray icon");

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("LG TV Remote")
                .on_tray_icon_event(|tray, event| {
                    // Try to handle left-click (works on GNOME, may not on KDE)
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle(), position.x, position.y);
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                WINDOW_VISIBLE.store(true, Ordering::SeqCst);
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            if let Err(e) = register_all_global_shortcuts(app.app_handle()) {
                log::warn!("Failed to register global shortcuts: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            is_dev,
            get_window_size,
            get_config,
            save_tv,
            set_active_tv,
            connect,
            authenticate,
            disconnect,
            get_status,
            send_button,
            volume_up,
            volume_down,
            set_mute,
            power_off,
            power_on,
            fetch_mac,
            set_mac,
            wake_streaming_device,
            set_streaming_device,
            set_wake_streaming_on_power_on,
            quit_app,
            get_shortcut_settings,
            set_shortcut,
            get_action_shortcuts,
            set_action_shortcuts,
            reset_window_size,
            get_autostart_enabled,
            set_autostart_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // On macOS, set activation policy to Accessory to hide from dock
    // Must be set after build but before run
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    app.run(|_, _| {});
}
