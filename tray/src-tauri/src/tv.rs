use futures_util::{SinkExt, StreamExt};
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            success: true,
            message: None,
            error: None,
            client_key: None,
            mac: None,
            payload: None,
        }
    }

    pub fn ok_with_message(msg: &str) -> Self {
        Self {
            success: true,
            message: Some(msg.to_string()),
            error: None,
            client_key: None,
            mac: None,
            payload: None,
        }
    }
}

pub struct TvConnection {
    ws: Option<Arc<Mutex<WsStream>>>,
    input_ws: Option<Arc<Mutex<WsStream>>>,
    msg_id: u32,
    pub connected: bool,
    pub ip: String,
    pub name: String,
    pub use_ssl: bool,
}

impl TvConnection {
    pub fn new() -> Self {
        Self {
            ws: None,
            input_ws: None,
            msg_id: 0,
            connected: false,
            ip: String::new(),
            name: String::new(),
            use_ssl: true,
        }
    }

    fn handshake_payload(client_key: Option<&str>) -> Value {
        let mut payload = json!({
            "type": "register",
            "id": "register_0",
            "payload": {
                "forcePairing": false,
                "pairingType": "PROMPT",
                "manifest": {
                    "manifestVersion": 1,
                    "appVersion": "1.1",
                    "signed": {
                        "created": "20140509",
                        "appId": "com.lge.test",
                        "vendorId": "com.lge",
                        "localizedAppNames": {"": "LG Remote"},
                        "localizedVendorNames": {"": "LG Electronics"},
                        "permissions": [
                            "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE",
                            "TEST_OPEN", "TEST_PROTECTED", "CONTROL_AUDIO",
                            "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
                            "CONTROL_INPUT_MEDIA_RECORDING",
                            "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV",
                            "CONTROL_POWER", "READ_APP_STATUS", "READ_CURRENT_CHANNEL",
                            "READ_INPUT_DEVICE_LIST", "READ_NETWORK_STATE",
                            "READ_RUNNING_APPS", "READ_TV_CHANNEL_LIST",
                            "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE",
                            "READ_COUNTRY_INFO", "CONTROL_MOUSE_AND_KEYBOARD",
                            "CONTROL_INPUT_TEXT"
                        ],
                        "serial": "2f930e2d2cfe083771f68e4fe7bb07"
                    },
                    "permissions": [
                        "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE",
                        "TEST_OPEN", "TEST_PROTECTED", "CONTROL_AUDIO",
                        "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
                        "CONTROL_INPUT_MEDIA_RECORDING",
                        "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV",
                        "CONTROL_POWER", "READ_APP_STATUS", "READ_CURRENT_CHANNEL",
                        "READ_INPUT_DEVICE_LIST", "READ_NETWORK_STATE",
                        "READ_RUNNING_APPS", "READ_TV_CHANNEL_LIST",
                        "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE",
                        "READ_COUNTRY_INFO", "CONTROL_MOUSE_AND_KEYBOARD",
                        "CONTROL_INPUT_TEXT"
                    ],
                    "signatures": [{
                        "signatureVersion": 1,
                        "signature": "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw=="
                    }]
                }
            }
        });

        if let Some(key) = client_key {
            payload["payload"]["client-key"] = json!(key);
        }

        payload
    }

    async fn connect_ws(uri: &str, use_ssl: bool) -> Result<WsStream, String> {
        if use_ssl {
            let connector = TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
                .map_err(|e| format!("TLS error: {}", e))?;

            let connector = tokio_tungstenite::Connector::NativeTls(connector);

            let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(
                uri,
                None,
                false,
                Some(connector),
            )
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

            Ok(ws)
        } else {
            let (ws, _) = tokio_tungstenite::connect_async(uri)
                .await
                .map_err(|e| format!("WebSocket connection failed: {}", e))?;
            Ok(ws)
        }
    }

    pub async fn connect(
        &mut self,
        name: &str,
        ip: &str,
        client_key: Option<&str>,
        use_ssl: bool,
    ) -> Result<CommandResult, String> {
        self.disconnect().await;

        self.name = name.to_string();
        self.ip = ip.to_string();
        self.use_ssl = use_ssl;

        let protocol = if use_ssl { "wss" } else { "ws" };
        let port = if use_ssl { 3001 } else { 3000 };
        let uri = format!("{}://{}:{}", protocol, ip, port);

        let ws = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Self::connect_ws(&uri, use_ssl),
        )
        .await
        .map_err(|_| "Connection timeout".to_string())?
        .map_err(|e| e.to_string())?;

        let ws = Arc::new(Mutex::new(ws));
        self.ws = Some(ws.clone());

        // Send handshake
        let handshake = Self::handshake_payload(client_key);
        {
            let mut ws = ws.lock().await;
            ws.send(Message::Text(handshake.to_string().into()))
                .await
                .map_err(|e| format!("Failed to send handshake: {}", e))?;
        }

        // Wait for registration response
        let timeout_secs = if client_key.is_some() { 5 } else { 60 };
        let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), async {
            loop {
                let msg = {
                    let mut ws = ws.lock().await;
                    ws.next().await
                };

                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(data) = serde_json::from_str::<Value>(&text) {
                            if data["type"] == "registered" {
                                let new_key = data["payload"]["client-key"]
                                    .as_str()
                                    .map(|s| s.to_string());
                                return Ok(new_key);
                            } else if data["type"] == "error" {
                                return Err(format!(
                                    "Registration error: {}",
                                    data["error"].as_str().unwrap_or("Unknown")
                                ));
                            }
                            // Keep waiting for other message types (like pairing prompts)
                        }
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(format!("WebSocket error: {}", e)),
                    None => return Err("Connection closed".to_string()),
                }
            }
        })
        .await
        .map_err(|_| "Registration timeout - check TV for pairing prompt".to_string())?;

        let new_key = response?;
        self.connected = true;

        // Connect input socket for button commands
        if let Err(e) = self.connect_input_socket().await {
            log::warn!("Could not connect input socket: {}", e);
        }

        let mut result = CommandResult::ok_with_message("Connected");
        result.client_key = new_key;
        Ok(result)
    }

    async fn connect_input_socket(&mut self) -> Result<(), String> {
        let response = self.send_command(
            "ssap://com.webos.service.networkinput/getPointerInputSocket",
            None,
        ).await?;

        let socket_path = response["payload"]["socketPath"]
            .as_str()
            .ok_or("No socket path in response")?;

        let ws = Self::connect_ws(socket_path, self.use_ssl).await?;
        self.input_ws = Some(Arc::new(Mutex::new(ws)));
        Ok(())
    }

    /// Refresh the input socket (used for d-pad, enter, back, etc.). The TV can close
    /// this socket while the main SSAP socket stays open; we don't ping it, so
    /// reconnect it periodically so button commands keep working.
    pub async fn refresh_input_socket(&mut self) -> Result<(), String> {
        if let Some(old) = self.input_ws.take() {
            let _ = old.lock().await.close(None).await;
        }
        self.connect_input_socket().await
    }

    pub async fn disconnect(&mut self) {
        self.connected = false;
        if let Some(ws) = self.input_ws.take() {
            let _ = ws.lock().await.close(None).await;
        }
        if let Some(ws) = self.ws.take() {
            let _ = ws.lock().await.close(None).await;
        }
    }

    pub async fn send_command(&mut self, uri: &str, payload: Option<Value>) -> Result<Value, String> {
        let ws = self.ws.as_ref().ok_or("Not connected")?;

        self.msg_id += 1;
        let msg = json!({
            "type": "request",
            "id": format!("cmd_{}", self.msg_id),
            "uri": uri,
            "payload": payload.unwrap_or(json!({}))
        });

        let mut ws = ws.lock().await;
        if let Err(e) = ws.send(Message::Text(msg.to_string().into())).await {
            self.connected = false;
            return Err(format!("Send failed (disconnected): {}", e));
        }

        // Wait for response
        let response = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while let Some(msg) = ws.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(data) = serde_json::from_str::<Value>(&text) {
                            return Ok(data);
                        }
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(format!("WebSocket error: {}", e)),
                }
            }
            Err("Connection closed".to_string())
        })
        .await;

        match response {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(e)) => {
                self.connected = false;
                Err(e)
            }
            Err(_) => {
                // Timeout - connection may be dead
                self.connected = false;
                Err("Command timeout (disconnected)".to_string())
            }
        }
    }

    pub async fn send_button(&mut self, button: &str) -> Result<CommandResult, String> {
        // Reconnect input socket if needed
        if self.input_ws.is_none() {
            if let Err(e) = self.connect_input_socket().await {
                self.connected = false;
                return Err(format!("Failed to connect input socket: {}", e));
            }
        }

        let input_ws = self.input_ws.as_ref().ok_or("Input socket not available")?;
        let cmd = format!("type:button\nname:{}\n\n", button.to_uppercase());

        let mut ws = input_ws.lock().await;
        if let Err(e) = ws.send(Message::Text(cmd.into())).await {
            // Input socket died, clear it so we reconnect next time
            drop(ws);
            self.input_ws = None;
            self.connected = false;
            return Err(format!("Button send failed (disconnected): {}", e));
        }

        Ok(CommandResult::ok())
    }

    pub async fn volume_up(&mut self) -> Result<CommandResult, String> {
        self.send_command("ssap://audio/volumeUp", None).await?;
        Ok(CommandResult::ok())
    }

    pub async fn volume_down(&mut self) -> Result<CommandResult, String> {
        self.send_command("ssap://audio/volumeDown", None).await?;
        Ok(CommandResult::ok())
    }

    pub async fn set_mute(&mut self, mute: bool) -> Result<CommandResult, String> {
        self.send_command("ssap://audio/setMute", Some(json!({ "mute": mute }))).await?;
        Ok(CommandResult::ok())
    }

    pub async fn power_off(&mut self) -> Result<CommandResult, String> {
        self.send_command("ssap://system/turnOff", None).await?;
        self.connected = false;
        Ok(CommandResult::ok_with_message("TV powered off"))
    }

    /// Lightweight keepalive to prevent idle connection drops.
    /// Sends a minimal SSAP request; if it fails, connection is marked disconnected.
    pub async fn keepalive_ping(&mut self) -> Result<(), String> {
        let uri = "ssap://com.webos.service.connectionmanager/getinfo";
        match self.send_command(uri, None).await {
            Ok(res) => {
                log::debug!("Keepalive ping response: {:?}", res);
                Ok(())
            }
            Err(e) => {
                log::debug!("Keepalive ping error: {}", e);
                Err(e)
            }
        }
    }

    pub async fn get_network_info(&mut self) -> Result<Value, String> {
        // Get MAC addresses from getinfo endpoint
        self.send_command("ssap://com.webos.service.connectionmanager/getinfo", None).await
    }

    /// Get connection status (which interface is connected).
    /// Tries connectionmanager/getStatus first, then com.webos.service.wifi/getstatus as fallback.
    fn check_status_response(response: &Value) -> Result<Value, String> {
        if response.get("error").is_some() {
            return Err(response["error"]
                .as_str()
                .unwrap_or("getStatus failed")
                .to_string());
        }
        Ok(response.clone())
    }

    pub async fn get_network_status(&mut self) -> Result<Value, String> {
        // Primary: com.webos.service.connectionmanager/getStatus (wifi + wired state)
        log::debug!("Trying connectionmanager/getStatus...");
        let response = self
            .send_command("ssap://com.webos.service.connectionmanager/getStatus", None)
            .await?;
        if let Ok(status) = Self::check_status_response(&response) {
            log::debug!("connectionmanager/getStatus succeeded");
            return Ok(status);
        }
        log::debug!("connectionmanager/getStatus failed, trying com.webos.service.wifi/getstatus...");
        // Fallback: com.webos.service.wifi/getstatus (lowercase per webOS OSE docs)
        let response = self
            .send_command("ssap://com.webos.service.wifi/getstatus", None)
            .await?;
        if let Ok(status) = Self::check_status_response(&response) {
            log::debug!("com.webos.service.wifi/getstatus succeeded");
            return Ok(status);
        }
        log::debug!("com.webos.service.wifi/getstatus failed, trying com.palm.wifi/getStatus...");
        // Some consumer TVs use the palm namespace
        let response = self
            .send_command("ssap://com.palm.wifi/getStatus", None)
            .await?;
        if let Ok(status) = Self::check_status_response(&response) {
            log::debug!("com.palm.wifi/getStatus succeeded");
            return Ok(status);
        }
        let err = response["error"].as_str().unwrap_or("unknown");
        Err(err.to_string())
    }

    /// Get the MAC address of the connected network interface
    pub async fn get_connected_mac(&mut self) -> Result<Option<String>, String> {
        // First get MAC addresses
        let info = self.get_network_info().await?;
        log::debug!("Network info: {:?}", info);

        let wifi_mac = info["payload"]["wifiInfo"]["macAddress"].as_str();
        let wired_mac = info["payload"]["wiredInfo"]["macAddress"].as_str();

        // Then check which interface is connected
        // !This doesn't seem to work all these endpoints 404, keep in case it works for some TVs
        match self.get_network_status().await {
            Ok(status) => {
                log::debug!("Network status: {:?}", status);

                let payload = &status["payload"];
                // connectionmanager format: wifi.state / wired.state
                let wifi_connected = payload["wifi"]["state"].as_str() == Some("connected")
                    || payload["wifiInfo"]["state"].as_str() == Some("connected")
                    || payload["isConnected"].as_bool() == Some(true)
                    // com.webos.service.wifi/getstatus: status "connectionStateChanged" or networkInfo present
                    || payload["status"].as_str() == Some("connectionStateChanged")
                    || status["status"].as_str() == Some("connectionStateChanged")
                    || payload["networkInfo"].is_object()
                    || status["networkInfo"].is_object();
                let wired_connected = payload["wired"]["state"].as_str() == Some("connected");

                // Return MAC of the connected interface
                if wired_connected {
                    if let Some(mac) = wired_mac {
                        log::info!("Using wired MAC (connected): {}", mac);
                        return Ok(Some(mac.to_string()));
                    }
                }
                if wifi_connected {
                    if let Some(mac) = wifi_mac {
                        log::info!("Using WiFi MAC (connected): {}", mac);
                        return Ok(Some(mac.to_string()));
                    }
                }

                // Fallback: return any available MAC
                log::warn!("Could not determine connected interface, using first available MAC");
                Ok(wifi_mac.or(wired_mac).map(|s| s.to_string()))
            }
            Err(e) => {
                // getStatus not supported on this TV (e.g. 404), use first available MAC
                log::warn!("getStatus not available ({}), using first available MAC", e);
                Ok(wifi_mac.or(wired_mac).map(|s| s.to_string()))
            }
        }
    }
}

/// Send Wake-on-LAN magic packet. If broadcast_ip is set (e.g. 10.0.0.255), also send to that
/// subnet broadcast on ports 9 and 7 — required on some networks where 255.255.255.255 is blocked.
pub fn wake_on_lan(mac: &str, broadcast_ip: Option<&str>) -> Result<CommandResult, String> {
    let mac_clean = mac.replace([':', '-'], "");
    let mac_bytes: [u8; 6] = hex::decode(&mac_clean)
        .map_err(|_| "Invalid MAC address")?
        .try_into()
        .map_err(|_| "Invalid MAC address length")?;

    let magic_packet = wake_on_lan::MagicPacket::new(&mac_bytes);
    magic_packet
        .send()
        .map_err(|e| format!("WoL send failed: {}", e))?;

    if let Some(ip) = broadcast_ip {
        let ip = ip.trim();
        if !ip.is_empty() {
            let from: &str = "0.0.0.0:0";
            for port in [9u16, 7] {
                let to_addr = format!("{}:{}", ip, port);
                if let Err(e) = magic_packet.send_to(to_addr.as_str(), from) {
                    log::warn!("WoL send_to {} failed: {}", to_addr, e);
                }
            }
        }
    }

    Ok(CommandResult::ok_with_message("Wake-on-LAN packet sent"))
}

/// Wake a Roku device via ECP (External Control Protocol). Sends keypress/PowerOn to port 8060.
pub async fn wake_roku(ip: &str) -> Result<CommandResult, String> {
    use tokio::io::{AsyncWriteExt, BufWriter};

    let mut stream = TcpStream::connect(format!("{}:8060", ip))
        .await
        .map_err(|e| format!("Could not reach Roku at {}:8060: {}", ip, e))?;

    // Roku ECP: POST /keypress/PowerOn with Host header set to IP (required by Roku).
    let req = format!(
        "POST /keypress/PowerOn HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ip
    );
    let mut writer = BufWriter::new(&mut stream);
    writer
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("Failed to send Roku wake: {}", e))?;
    writer.flush().await.map_err(|e| e.to_string())?;

    Ok(CommandResult::ok_with_message("Roku wake sent"))
}

/// Wake an Android TV / NVIDIA Shield via ADB. Requires Network debugging enabled on the device.
/// Uses system `adb` from PATH.
pub async fn wake_adb(ip: &str, port: u16) -> Result<CommandResult, String> {
    use tokio::process::Command;

    let target = format!("{}:{}", ip, port);
    let output = Command::new("adb")
        .args(["connect", &target])
        .output()
        .await
        .map_err(|e| format!("adb not found or failed: {}. Install Android platform tools (e.g. brew install android-platform-tools).", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("adb connect failed: {}", stderr.trim()));
    }

    let output = Command::new("adb")
        .args(["-s", &target, "shell", "input", "keyevent", "KEYCODE_WAKEUP"])
        .output()
        .await
        .map_err(|e| format!("adb shell failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("adb wake failed: {}", stderr.trim()));
    }

    Ok(CommandResult::ok_with_message("ADB wake sent"))
}

// Need to add hex as a dependency or implement manually
mod hex {
    pub fn decode(s: &str) -> Result<Vec<u8>, ()> {
        if s.len() % 2 != 0 {
            return Err(());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
            .collect()
    }
}
