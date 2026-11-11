//! Opt-in OS media keys / Now Playing session (souvlaki).
//! Active only when enabled in settings and the TV is connected.

use crate::{AppState, run_action_impl};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig, SeekDirection,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

pub struct MediaKeys {
    controls: Option<MediaControls>,
    playing: AtomicBool,
}

impl Default for MediaKeys {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaKeys {
    pub fn new() -> Self {
        Self {
            controls: None,
            playing: AtomicBool::new(true),
        }
    }

    fn detach(&mut self) {
        if let Some(mut controls) = self.controls.take()
            && let Err(e) = controls.detach()
        {
            log::warn!("Failed to detach OS media keys: {e}");
        }
        self.playing.store(true, Ordering::SeqCst);
    }

    fn attach(&mut self, app: &AppHandle, state: Arc<AppState>, title: &str) -> Result<(), String> {
        if self.controls.is_some() {
            self.apply_session_info(title);
            return Ok(());
        }

        let hwnd = hwnd_for_platform(app)?;
        let config = PlatformConfig {
            dbus_name: "lgtv_remote",
            display_name: "LG TV Remote",
            hwnd,
        };

        let mut controls = MediaControls::new(config).map_err(|e| e.to_string())?;
        let state_for_handler = state.clone();
        let app_for_handler = app.clone();

        controls
            .attach(move |event| {
                handle_media_event(&app_for_handler, state_for_handler.clone(), event);
            })
            .map_err(|e| e.to_string())?;

        self.playing.store(true, Ordering::SeqCst);
        self.controls = Some(controls);
        self.apply_session_info(title);
        Ok(())
    }

    fn apply_session_info(&mut self, title: &str) {
        let Some(controls) = self.controls.as_mut() else {
            return;
        };
        if let Err(e) = controls.set_metadata(MediaMetadata {
            title: Some(title),
            artist: Some("LG TV Remote"),
            ..Default::default()
        }) {
            log::warn!("Failed to set OS media metadata: {e}");
        }
        self.apply_playback();
    }

    fn apply_playback(&mut self) {
        let Some(controls) = self.controls.as_mut() else {
            return;
        };
        let playback = if self.playing.load(Ordering::SeqCst) {
            MediaPlayback::Playing { progress: None }
        } else {
            MediaPlayback::Paused { progress: None }
        };
        if let Err(e) = controls.set_playback(playback) {
            log::warn!("Failed to set OS media playback: {e}");
        }
    }
}

/// Attach or detach the OS media session based on settings + connection.
pub async fn sync(app: &AppHandle, state: Arc<AppState>) {
    let (enabled, title) = {
        let config = state.config.lock().await;
        let title = config
            .active_tv
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "LG TV".to_string());
        (config.os_media_keys_enabled, title)
    };
    let connected = state.tv.lock().await.connected;
    let should_attach = enabled && connected;

    let mut media_keys = match state.media_keys.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if should_attach {
        if let Err(e) = media_keys.attach(app, state.clone(), &title) {
            log::warn!("Failed to enable OS media keys: {e}");
            media_keys.detach();
        }
    } else {
        media_keys.detach();
    }
}

fn handle_media_event(app: &AppHandle, state: Arc<AppState>, event: MediaControlEvent) {
    let action = {
        let mut media_keys = match state.media_keys.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        map_event_to_action(&mut media_keys, event)
    };

    let Some(action_id) = action else {
        return;
    };

    let state_run = state.clone();
    let app_run = app.clone();
    let action_emit = action_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_action_impl(app_run.clone(), state_run, action_id).await {
            log::warn!("OS media key action {action_id} failed: {e}");
        }
        if let Some(window) = app_run.get_webview_window("main") {
            let _ = window.emit("run-command", &action_emit);
        }
    });
}

fn map_event_to_action(
    media_keys: &mut MediaKeys,
    event: MediaControlEvent,
) -> Option<&'static str> {
    let action = match event {
        MediaControlEvent::Play => {
            media_keys.playing.store(true, Ordering::SeqCst);
            Some("play")
        }
        MediaControlEvent::Pause => {
            media_keys.playing.store(false, Ordering::SeqCst);
            Some("pause")
        }
        MediaControlEvent::Toggle => {
            let now_playing = !media_keys.playing.load(Ordering::SeqCst);
            media_keys.playing.store(now_playing, Ordering::SeqCst);
            if now_playing {
                Some("play")
            } else {
                Some("pause")
            }
        }
        MediaControlEvent::Stop => {
            media_keys.playing.store(false, Ordering::SeqCst);
            Some("stop")
        }
        MediaControlEvent::Next => Some("fast_forward"),
        MediaControlEvent::Previous => Some("rewind"),
        MediaControlEvent::Seek(SeekDirection::Forward)
        | MediaControlEvent::SeekBy(SeekDirection::Forward, _) => Some("fast_forward"),
        MediaControlEvent::Seek(SeekDirection::Backward)
        | MediaControlEvent::SeekBy(SeekDirection::Backward, _) => Some("rewind"),
        MediaControlEvent::SetPosition(_)
        | MediaControlEvent::SetVolume(_)
        | MediaControlEvent::SetShuffle(_)
        | MediaControlEvent::OpenUri(_)
        | MediaControlEvent::Raise
        | MediaControlEvent::Quit => None,
        _ => None,
    };

    if matches!(
        event,
        MediaControlEvent::Play
            | MediaControlEvent::Pause
            | MediaControlEvent::Toggle
            | MediaControlEvent::Stop
    ) {
        media_keys.apply_playback();
    }

    action
}

#[cfg(target_os = "windows")]
fn hwnd_for_platform(app: &AppHandle) -> Result<Option<*mut std::ffi::c_void>, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not available for OS media keys".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND for OS media keys: {e}"))?;
    Ok(Some(hwnd.0 as *mut std::ffi::c_void))
}

#[cfg(not(target_os = "windows"))]
fn hwnd_for_platform(_app: &AppHandle) -> Result<Option<*mut std::ffi::c_void>, String> {
    Ok(None)
}
