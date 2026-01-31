// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tv;

use config::{Config, TvConfig, WindowSize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::Mutex;
use tv::{CommandResult, TvConnection};

// Track window visibility ourselves since is_visible() can be unreliable
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(false);

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

#[tauri::command]
async fn connect(state: tauri::State<'_, Arc<AppState>>) -> Result<CommandResult, String> {
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

    Ok(result)
}

#[tauri::command]
async fn authenticate(
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
        if let Ok(info) = tv.get_network_info().await {
            let mac = info["payload"]["wired"]["macAddress"]
                .as_str()
                .or_else(|| info["payload"]["wifi"]["macAddress"].as_str())
                .map(|s| s.to_string());

            if let Some(mac) = mac {
                config.update_mac(&name, mac);
            }
        }

        config.save()?;
    }

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
    let config = state.config.lock().await;
    let (_, tv_config) = config.get_active_tv().ok_or("No TV configured")?;

    let mac = tv_config
        .mac
        .as_ref()
        .ok_or("MAC address not saved. Authenticate first while TV is on.")?;

    tv::wake_on_lan(mac)
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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
    // Update config
    {
        let mut config = state.config.lock().await;
        config.global_shortcut = shortcut.clone();
        config.shortcut_enabled = enabled;
        config.save()?;
    }

    // Update the registered shortcut
    update_global_shortcut(&app, &shortcut, enabled)?;
    
    Ok(())
}

fn update_global_shortcut(app: &AppHandle, shortcut_str: &str, enabled: bool) -> Result<(), String> {
    let manager = app.global_shortcut();
    
    // Unregister all existing shortcuts first
    manager.unregister_all().map_err(|e| e.to_string())?;
    
    if enabled && !shortcut_str.is_empty() {
        let shortcut: Shortcut = shortcut_str.parse()
            .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_str, e))?;
        
        let app_handle = app.clone();
        manager.on_shortcut(shortcut, move |_app, _shortcut, event| {
            // Only toggle on key release to avoid double-firing
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
        }).map_err(|e| format!("Failed to register shortcut: {}", e))?;
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

    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Focused(false) => {
                            let _ = window_clone.hide();
                            WINDOW_VISIBLE.store(false, Ordering::SeqCst);
                        }
                        tauri::WindowEvent::Resized(size) => {
                            // Save new window size
                            if size.width > 0 && size.height > 0 {
                                let mut config = Config::load();
                                config.window_size = Some(WindowSize {
                                    width: size.width,
                                    height: size.height,
                                });
                                let _ = config.save();
                            }
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

            // Register global shortcut if enabled (load config directly since we're in sync context)
            let config = Config::load();
            if config.shortcut_enabled {
                if let Err(e) = update_global_shortcut(app.app_handle(), &config.global_shortcut, true) {
                    log::warn!("Failed to register global shortcut: {}", e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            quit_app,
            get_shortcut_settings,
            set_shortcut,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // On macOS, set activation policy to Accessory to hide from dock
    // Must be set after build but before run
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    app.run(|_, _| {});
}
