#!/usr/bin/env python3
"""
LG TV Remote - WebOS TV Controller
A self-contained script to control LG webOS TVs via WebSocket.
No external dependencies beyond Python standard library + websockets.
"""

import asyncio
import json
import ssl
import sys
import os
from pathlib import Path

# Try to import websockets, provide helpful error if missing
try:
    import websockets
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "websockets module not found. Install with: nix-shell -p python3Packages.websockets"
    }))
    sys.exit(1)

# Config file location
CONFIG_DIR = Path.home() / ".config" / "lgtv-remote"
CONFIG_FILE = CONFIG_DIR / "config.json"

def load_config():
    """Load saved TV configurations."""
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except:
            pass
    return {"tvs": {}}

def save_config(config):
    """Save TV configurations."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2))

def get_ssl_context():
    """Create SSL context that accepts self-signed certs (LG TVs use these)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

class LGTVClient:
    """Simple LG webOS TV client."""
    
    HANDSHAKE = {
        "type": "register",
        "id": "register_0",
        "payload": {
            "forcePairing": False,
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
    }
    
    COMMANDS = {
        "volumeUp": ("ssap://audio/volumeUp", {}),
        "volumeDown": ("ssap://audio/volumeDown", {}),
        "off": ("ssap://system/turnOff", {}),
        "getVolume": ("ssap://audio/getVolume", {}),
        "channelUp": ("ssap://tv/channelUp", {}),
        "channelDown": ("ssap://tv/channelDown", {}),
        "getSystemInfo": ("ssap://system/getSystemInfo", {}),
    }
    
    BUTTONS = {
        "UP": "UP", "DOWN": "DOWN", "LEFT": "LEFT", "RIGHT": "RIGHT",
        "ENTER": "ENTER", "BACK": "BACK", "HOME": "HOME", "EXIT": "EXIT",
        "MENU": "MENU", "INFO": "INFO", "PLAY": "PLAY", "PAUSE": "PAUSE",
        "STOP": "STOP", "REWIND": "REWIND", "FASTFORWARD": "FASTFORWARD",
        "MUTE": "MUTE", "VOLUMEUP": "VOLUMEUP", "VOLUMEDOWN": "VOLUMEDOWN",
        "CHANNELUP": "CHANNELUP", "CHANNELDOWN": "CHANNELDOWN",
        "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
        "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    }
    
    def __init__(self, ip, name, use_ssl=True):
        self.ip = ip
        self.name = name
        self.use_ssl = use_ssl
        self.ws = None
        self.msg_id = 0
        self.client_key = None
        
        # Load saved client key
        config = load_config()
        if name in config.get("tvs", {}):
            self.client_key = config["tvs"][name].get("client_key")
    
    def _get_uri(self):
        protocol = "wss" if self.use_ssl else "ws"
        port = 3001 if self.use_ssl else 3000
        return f"{protocol}://{self.ip}:{port}"
    
    async def connect(self):
        """Connect to the TV."""
        uri = self._get_uri()
        ssl_context = get_ssl_context() if self.use_ssl else None
        
        try:
            self.ws = await asyncio.wait_for(
                websockets.connect(uri, ssl=ssl_context, close_timeout=2),
                timeout=5
            )
            return True
        except Exception as e:
            raise ConnectionError(f"Failed to connect to TV: {e}")
    
    async def register(self):
        """Register/authenticate with the TV."""
        import copy
        handshake = copy.deepcopy(self.HANDSHAKE)
        if self.client_key:
            handshake["payload"]["client-key"] = self.client_key
        
        await self.ws.send(json.dumps(handshake))
        
        # Wait for registration response
        # Short timeout if we have a key (should be instant), longer for new pairing
        timeout = 5 if self.client_key else 60
        
        while True:
            response = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            data = json.loads(response)
            
            if data.get("type") == "registered":
                # Save the client key for future connections
                new_key = data.get("payload", {}).get("client-key")
                if new_key and new_key != self.client_key:
                    self.client_key = new_key
                    config = load_config()
                    if "tvs" not in config:
                        config["tvs"] = {}
                    config["tvs"][self.name] = {
                        "ip": self.ip,
                        "client_key": new_key
                    }
                    save_config(config)
                return True
            elif data.get("type") == "response" and data.get("payload", {}).get("pairingType"):
                # Pairing prompt shown, wait for user (extend timeout)
                timeout = 60
                continue
            elif data.get("type") == "error":
                raise Exception(data.get("error", "Registration failed"))
    
    async def send_command(self, uri, payload=None):
        """Send a command to the TV."""
        self.msg_id += 1
        msg = {
            "type": "request",
            "id": f"cmd_{self.msg_id}",
            "uri": uri,
            "payload": payload or {}
        }
        await self.ws.send(json.dumps(msg))
        
        # Wait for response (short timeout for responsiveness)
        response = await asyncio.wait_for(self.ws.recv(), timeout=3)
        return json.loads(response)
    
    async def send_button(self, button):
        """Send a button press using the input socket."""
        # Get pointer input socket
        response = await self.send_command("ssap://com.webos.service.networkinput/getPointerInputSocket")
        socket_path = response.get("payload", {}).get("socketPath")
        
        if not socket_path:
            raise Exception(f"Failed to get input socket. Response: {response}")
        
        # Connect to input socket
        ssl_context = get_ssl_context() if self.use_ssl else None
        try:
            async with websockets.connect(socket_path, ssl=ssl_context) as input_ws:
                btn_name = button.upper()
                cmd = f"type:button\nname:{btn_name}\n\n"
                await input_ws.send(cmd)
                # Minimal delay - just enough for the command to be sent
                await asyncio.sleep(0.05)
            
            return {"success": True}
        except Exception as e:
            raise Exception(f"Input socket error: {e}")
    
    async def close(self):
        """Close the connection."""
        if self.ws:
            await self.ws.close()


async def run_command(ip, name, command, args=None, use_ssl=True):
    """Run a command on the TV."""
    
    # Power on uses Wake-on-LAN (doesn't need WebSocket)
    if command == "on":
        return await wake_on_lan_async(name)
    
    client = LGTVClient(ip, name, use_ssl)
    
    try:
        await client.connect()
        await client.register()
        
        # Handle different command types
        if command == "sendButton":
            button = args[0].upper() if args else "ENTER"
            if button not in client.BUTTONS:
                return {"success": False, "error": f"Unknown button: {button}"}
            result = await client.send_button(button)
        
        elif command == "mute":
            # Discrete mute (true) or unmute (false)
            mute_value = True  # default to mute
            if args and args[0].lower() in ("false", "0", "off"):
                mute_value = False
            result = await client.send_command("ssap://audio/setMute", {"mute": mute_value})
            return {"success": True, "result": result, "muted": mute_value}
        
        elif command in client.COMMANDS:
            uri, payload = client.COMMANDS[command]
            result = await client.send_command(uri, payload)
        
        else:
            return {"success": False, "error": f"Unknown command: {command}"}
        
        return {"success": True, "result": result}
    
    except Exception as e:
        return {"success": False, "error": str(e)}
    
    finally:
        await client.close()


async def wake_on_lan_async(name):
    """Send Wake-on-LAN magic packet to turn on TV."""
    import socket
    
    config = load_config()
    tv_config = config.get("tvs", {}).get(name, {})
    mac = tv_config.get("mac")
    
    if not mac:
        return {"success": False, "error": "MAC address not saved. Turn TV on, run Auth to save MAC."}
    
    try:
        mac_bytes = bytes.fromhex(mac.replace(":", "").replace("-", ""))
        magic_packet = b'\xff' * 6 + mac_bytes * 16
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(magic_packet, ('255.255.255.255', 9))
        sock.close()
        
        return {"success": True, "message": "Wake-on-LAN packet sent"}
    except Exception as e:
        return {"success": False, "error": f"WoL failed: {e}"}


def _is_error_response(data):
    """Return True if the response indicates an API error (e.g. 404)."""
    return isinstance(data, dict) and "error" in data


def _get_nested_str(obj, *keys):
    """Safely get a nested string from a dict."""
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj if isinstance(obj, str) else None


def _extract_mac_from_payload(payload):
    """Extract MAC from various possible keys; return None if not found or invalid."""
    if not isinstance(payload, dict):
        return None
    candidates = [
        _get_nested_str(payload, "wifiInfo", "macAddress"),
        _get_nested_str(payload, "wiredInfo", "macAddress"),
        _get_nested_str(payload, "wifi", "macAddress"),
        _get_nested_str(payload, "wired", "macAddress"),
        _get_nested_str(payload, "wifi", "hwAddr"),
        _get_nested_str(payload, "wired", "hwAddr"),
        _get_nested_str(payload, "device_id"),
        _get_nested_str(payload, "macAddress"),
    ]
    for c in candidates:
        if c and len(c.replace(":", "").replace("-", "").replace(" ", "")) == 12:
            return c
    return None


def _normalize_mac(mac):
    """Normalize MAC to uppercase with colons (e.g. AA:BB:CC:DD:EE:FF)."""
    if not mac:
        return None
    clean = mac.replace(":", "").replace("-", "").replace(" ", "").upper()
    if len(clean) != 12 or not all(c in "0123456789ABCDEF" for c in clean):
        return None
    return ":".join(clean[i : i + 2] for i in range(0, 12, 2))


async def _get_mac_from_tv(client):
    """Try multiple webOS APIs to get MAC address; return normalized MAC or None."""
    mac = None
    # 1) connectionmanager/getinfo – primary source for MAC on many TVs
    try:
        info = await client.send_command("ssap://com.webos.service.connectionmanager/getinfo")
        if not _is_error_response(info):
            mac = _extract_mac_from_payload(info.get("payload", {}))
    except Exception:
        pass
    # 2) connectionmanager/getStatus – some TVs expose MAC here
    if not mac:
        try:
            data = await client.send_command("ssap://com.webos.service.connectionmanager/getStatus")
            if not _is_error_response(data):
                mac = _extract_mac_from_payload(data.get("payload", {}))
        except Exception:
            pass
    # 3) system/getSystemInfo – fallback
    if not mac:
        try:
            data = await client.send_command("ssap://system/getSystemInfo")
            if not _is_error_response(data):
                mac = _extract_mac_from_payload(data.get("payload", {}))
        except Exception:
            pass
    return _normalize_mac(mac) if mac else None


async def authenticate(ip, name, use_ssl=True):
    """Authenticate with a TV (triggers pairing prompt) and save MAC for WoL."""
    client = LGTVClient(ip, name, use_ssl)
    
    try:
        await client.connect()
        await client.register()
        
        mac = await _get_mac_from_tv(client)
        
        if mac:
            config = load_config()
            if name in config.get("tvs", {}):
                config["tvs"][name]["mac"] = mac
                save_config(config)
        
        msg = "Authentication successful. Key saved."
        if mac:
            msg += f" MAC: {mac}"
        else:
            msg += " (MAC not found - Power On may not work)"
        
        return {"success": True, "message": msg}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        await client.close()


async def wake_on_lan(mac_address):
    """Send Wake-on-LAN magic packet."""
    import socket
    
    # Create magic packet
    mac_bytes = bytes.fromhex(mac_address.replace(":", "").replace("-", ""))
    magic_packet = b'\xff' * 6 + mac_bytes * 16
    
    # Send to broadcast
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.sendto(magic_packet, ('255.255.255.255', 9))
    sock.close()
    
    return {"success": True, "message": "Wake-on-LAN packet sent"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: lgtv_remote.py <command> [args...]"}))
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "auth":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Usage: auth <ip> <name> [--ssl/--no-ssl]"}))
            sys.exit(1)
        ip = sys.argv[2]
        name = sys.argv[3]
        use_ssl = "--no-ssl" not in sys.argv
        result = asyncio.run(authenticate(ip, name, use_ssl))
        
    elif command == "send":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Usage: send <name> <command> [args] [--ssl/--no-ssl]"}))
            sys.exit(1)
        name = sys.argv[2]
        cmd = sys.argv[3]
        args = sys.argv[4].split(",") if len(sys.argv) > 4 and sys.argv[4] and sys.argv[4] not in ("--no-ssl", "--ssl", "") else []
        use_ssl = "--no-ssl" not in sys.argv
        
        # Look up IP from config
        config = load_config()
        tv_config = config.get("tvs", {}).get(name, {})
        ip = tv_config.get("ip")
        
        if not ip:
            print(json.dumps({"success": False, "error": f"TV '{name}' not found. Run auth first."}))
            sys.exit(1)
        
        result = asyncio.run(run_command(ip, name, cmd, args, use_ssl))
        
    elif command == "wol":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "Usage: wol <mac_address>"}))
            sys.exit(1)
        result = asyncio.run(wake_on_lan(sys.argv[2]))
        
    elif command == "list":
        config = load_config()
        result = {"success": True, "tvs": list(config.get("tvs", {}).keys())}
        
    else:
        print(json.dumps({"success": False, "error": f"Unknown command: {command}"}))
        sys.exit(1)
    
    print(json.dumps(result))


if __name__ == "__main__":
    main()
