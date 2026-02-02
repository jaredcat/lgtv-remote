use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Per-action shortcut: key combination and whether it is a global hotkey.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionShortcutConfig {
    pub shortcut: String,
    pub global: bool,
}

impl Default for ActionShortcutConfig {
    fn default() -> Self {
        Self {
            shortcut: String::new(),
            global: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TvConfig {
    pub ip: String,
    #[serde(default)]
    pub client_key: Option<String>,
    #[serde(default)]
    pub mac: Option<String>,
    #[serde(default)]
    pub use_ssl: bool,
}

/// Optional streaming device (Android TV, Roku, etc.) to wake when it's in standby.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamingDeviceConfig {
    /// Wake via Wake-on-LAN (works for Android TV / NVIDIA Shield, many set-top boxes on Ethernet).
    /// broadcast_ip: optional subnet broadcast (e.g. 10.0.0.255) — try this if 255.255.255.255 doesn't work.
    Wol {
        mac: String,
        #[serde(default)]
        broadcast_ip: Option<String>,
    },
    /// Wake via ADB (Android Debug Bridge). Requires Network debugging enabled on the device.
    Adb {
        ip: String,
        #[serde(default)]
        port: Option<u16>,
    },
    /// Wake via Roku ECP (HTTP keypress/PowerOn).
    Roku { ip: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub tvs: HashMap<String, TvConfig>,
    #[serde(default)]
    pub active_tv: Option<String>,
    /// Optional streaming device to wake (e.g. Shield, Roku). When set, "Wake streaming device" is available.
    #[serde(default)]
    pub streaming_device: Option<StreamingDeviceConfig>,
    /// If true, also send wake to streaming device when user triggers "Power On" (TV WoL).
    #[serde(default)]
    pub wake_streaming_on_power_on: bool,
    #[serde(default = "default_shortcut")]
    pub global_shortcut: String,
    #[serde(default)]
    pub shortcut_enabled: bool,
    /// Action id -> shortcut config (shortcut string, global). Keys match frontend ACTION_IDS.
    #[serde(default = "default_action_shortcuts")]
    pub action_shortcuts: HashMap<String, ActionShortcutConfig>,
    #[serde(default)]
    pub window_size: Option<WindowSize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

impl Default for WindowSize {
    fn default() -> Self {
        Self { width: 300, height: 400 }
    }
}

fn default_action_shortcuts() -> HashMap<String, ActionShortcutConfig> {
    let mut m = HashMap::new();
    let default = |shortcut: &str, global: bool| ActionShortcutConfig {
        shortcut: shortcut.to_string(),
        global,
    };
    m.insert("up".to_string(), default("Up", false));
    m.insert("down".to_string(), default("Down", false));
    m.insert("left".to_string(), default("Left", false));
    m.insert("right".to_string(), default("Right", false));
    m.insert("enter".to_string(), default("Return", false));
    m.insert("back".to_string(), default("Backspace", false));
    m.insert("volume_up".to_string(), default("=", false));
    m.insert("volume_down".to_string(), default("-", false));
    m.insert("mute".to_string(), default("Shift+-", false));
    m.insert("unmute".to_string(), default("Shift+=", false));
    m.insert("power_on".to_string(), default("F7", false));
    m.insert("power_off".to_string(), default("F8", false));
    m.insert("wake_streaming_device".to_string(), default("", false));
    m.insert("home".to_string(), default("Home", false));
    m
}

fn default_shortcut() -> String {
    "Super+Shift+T".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tvs: HashMap::new(),
            active_tv: None,
            streaming_device: None,
            wake_streaming_on_power_on: false,
            global_shortcut: default_shortcut(),
            shortcut_enabled: false,
            action_shortcuts: default_action_shortcuts(),
            window_size: None,
        }
    }
}

impl Config {
    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Ok(contents) = fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str(&contents) {
                    return config;
                }
            }
        }
        Config::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let contents = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, contents).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn config_path() -> PathBuf {
        let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        config_dir.join("lgtv-remote").join("config.json")
    }

    pub fn get_active_tv(&self) -> Option<(&String, &TvConfig)> {
        if let Some(ref name) = self.active_tv {
            self.tvs.get(name).map(|tv| (name, tv))
        } else {
            self.tvs.iter().next()
        }
    }

    pub fn set_tv(&mut self, name: String, config: TvConfig) {
        self.tvs.insert(name.clone(), config);
        if self.active_tv.is_none() {
            self.active_tv = Some(name);
        }
    }

    pub fn update_client_key(&mut self, name: &str, key: String) {
        if let Some(tv) = self.tvs.get_mut(name) {
            tv.client_key = Some(key);
        }
    }

    pub fn update_mac(&mut self, name: &str, mac: String) {
        if let Some(tv) = self.tvs.get_mut(name) {
            tv.mac = Some(mac);
        }
    }

    pub fn set_streaming_device(&mut self, device: Option<StreamingDeviceConfig>) {
        self.streaming_device = device;
    }
}
