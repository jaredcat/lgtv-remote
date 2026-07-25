"""LG webOS TV control over WebSocket (SSAP)."""

from __future__ import annotations

import asyncio
import copy
import json
import socket
import ssl
from typing import TYPE_CHECKING, ClassVar, cast

if TYPE_CHECKING:
    from websockets.asyncio.client import ClientConnection

try:
    import websockets
except ImportError as exc:
    raise ImportError(
        "websockets is required. Run: pip install websockets -t py_modules --no-deps"
    ) from exc

from lgtv.types import (
    JsonDict,
    json_dict_get_dict,
    json_dict_get_str,
    parse_json,
)

HANDSHAKE: JsonDict = {
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
                "appId": "com.codekitties.lgtv.remote",
                "vendorId": "com.codekitties",
                "localizedAppNames": {"": "LG TV Remote"},
                "localizedVendorNames": {"": "Code Kitties"},
                "permissions": [
                    "LAUNCH",
                    "LAUNCH_WEBAPP",
                    "APP_TO_APP",
                    "CLOSE",
                    "TEST_OPEN",
                    "TEST_PROTECTED",
                    "CONTROL_AUDIO",
                    "CONTROL_DISPLAY",
                    "CONTROL_INPUT_JOYSTICK",
                    "CONTROL_INPUT_MEDIA_RECORDING",
                    "CONTROL_INPUT_MEDIA_PLAYBACK",
                    "CONTROL_INPUT_TV",
                    "CONTROL_POWER",
                    "READ_APP_STATUS",
                    "READ_CURRENT_CHANNEL",
                    "READ_INPUT_DEVICE_LIST",
                    "READ_NETWORK_STATE",
                    "READ_RUNNING_APPS",
                    "READ_TV_CHANNEL_LIST",
                    "WRITE_NOTIFICATION_TOAST",
                    "READ_POWER_STATE",
                    "READ_COUNTRY_INFO",
                    "CONTROL_MOUSE_AND_KEYBOARD",
                    "CONTROL_INPUT_TEXT",
                ],
                "serial": "2f930e2d2cfe083771f68e4fe7bb07",
            },
            "permissions": [
                "LAUNCH",
                "LAUNCH_WEBAPP",
                "APP_TO_APP",
                "CLOSE",
                "TEST_OPEN",
                "TEST_PROTECTED",
                "CONTROL_AUDIO",
                "CONTROL_DISPLAY",
                "CONTROL_INPUT_JOYSTICK",
                "CONTROL_INPUT_MEDIA_RECORDING",
                "CONTROL_INPUT_MEDIA_PLAYBACK",
                "CONTROL_INPUT_TV",
                "CONTROL_POWER",
                "READ_APP_STATUS",
                "READ_CURRENT_CHANNEL",
                "READ_INPUT_DEVICE_LIST",
                "READ_NETWORK_STATE",
                "READ_RUNNING_APPS",
                "READ_TV_CHANNEL_LIST",
                "WRITE_NOTIFICATION_TOAST",
                "READ_POWER_STATE",
                "READ_COUNTRY_INFO",
                "CONTROL_MOUSE_AND_KEYBOARD",
                "CONTROL_INPUT_TEXT",
            ],
            "signatures": [
                {
                    "signatureVersion": 1,
                    "signature": "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==",
                }
            ],
        },
    },
}

TV_COMMANDS: dict[str, tuple[str, JsonDict]] = {
    "volumeUp": ("ssap://audio/volumeUp", {}),
    "volumeDown": ("ssap://audio/volumeDown", {}),
    "off": ("ssap://system/turnOff", {}),
    "getVolume": ("ssap://audio/getVolume", {}),
    "channelUp": ("ssap://tv/channelUp", {}),
    "channelDown": ("ssap://tv/channelDown", {}),
    "getSystemInfo": ("ssap://system/getSystemInfo", {}),
}

TV_BUTTONS: dict[str, str] = {
    "UP": "UP",
    "DOWN": "DOWN",
    "LEFT": "LEFT",
    "RIGHT": "RIGHT",
    "ENTER": "ENTER",
    "BACK": "BACK",
    "HOME": "HOME",
    "EXIT": "EXIT",
    "MENU": "MENU",
    "INFO": "INFO",
    "PLAY": "PLAY",
    "PAUSE": "PAUSE",
    "STOP": "STOP",
    "REWIND": "REWIND",
    "FASTFORWARD": "FASTFORWARD",
    "MUTE": "MUTE",
    "VOLUMEUP": "VOLUMEUP",
    "VOLUMEDOWN": "VOLUMEDOWN",
    "CHANNELUP": "CHANNELUP",
    "CHANNELDOWN": "CHANNELDOWN",
    "0": "0",
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5",
    "6": "6",
    "7": "7",
    "8": "8",
    "9": "9",
}


def get_ssl_context() -> ssl.SSLContext:
    """Permissive TLS for LG webOS TVs (self-signed / partial certificate chain)."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def is_ssl_verify_error(exc: BaseException) -> bool:
    if isinstance(exc, ssl.SSLCertVerificationError):
        return True
    if isinstance(exc, ssl.SSLError):
        message = str(exc).upper()
        if "CERTIFICATE_VERIFY_FAILED" in message or "UNABLE_TO_GET_ISSUER_CERT" in message:
            return True
    for link in (exc.__cause__, exc.__context__):
        if link is not None and link is not exc and is_ssl_verify_error(link):
            return True
    return False


PeerCertNamePart = tuple[tuple[str, str], ...]
PeerCertSubject = tuple[PeerCertNamePart, ...]
PeerCertDict = dict[str, str | PeerCertSubject | PeerCertNamePart]


def _as_cert_subject(value: str | PeerCertSubject | PeerCertNamePart) -> PeerCertSubject | None:
    if not isinstance(value, tuple) or not value:
        return None
    first = value[0]
    if first and isinstance(first[0], tuple):
        return cast(PeerCertSubject, value)
    return None


def _as_cert_alt_names(
    value: str | PeerCertSubject | PeerCertNamePart,
) -> PeerCertNamePart | None:
    if not isinstance(value, tuple) or not value:
        return None
    first = value[0]
    if first and isinstance(first[0], str):
        return cast(PeerCertNamePart, value)
    return None


def _hostname_from_peer_cert(cert: PeerCertDict | None) -> str | None:
    if not cert:
        return None
    subject = _as_cert_subject(cert["subject"]) if "subject" in cert else None
    if subject:
        for rdn in subject:
            for key, value in rdn:
                if key == "commonName":
                    return value
    alt_names = _as_cert_alt_names(cert["subjectAltName"]) if "subjectAltName" in cert else None
    if alt_names:
        for kind, value in alt_names:
            if kind in {"DNS", "IP Address"}:
                return value
    return None


def _fetch_tv_ssl_pin(ip: str) -> tuple[str, str]:
    """Fetch the TV TLS certificate and hostname for storage (optional metadata)."""
    cert_pem = ssl.get_server_certificate((ip, 3001))
    ctx = get_ssl_context()
    with socket.create_connection((ip, 3001), timeout=5) as sock:
        with ctx.wrap_socket(sock, server_hostname=ip) as tls:
            server_name = _hostname_from_peer_cert(tls.getpeercert()) or ip
    return cert_pem, server_name


def normalize_mac(mac: str | None) -> str | None:
    if not mac:
        return None
    clean = mac.replace(":", "").replace("-", "").replace(" ", "").upper()
    if len(clean) != 12 or not all(c in "0123456789ABCDEF" for c in clean):
        return None
    return ":".join(clean[i : i + 2] for i in range(0, 12, 2))


def wol_send(mac: str, broadcast_ip: str | None = None) -> None:
    mac_clean = mac.replace(":", "").replace("-", "").replace(" ", "")
    mac_bytes = bytes.fromhex(mac_clean)
    magic_packet = b"\xff" * 6 + mac_bytes * 16
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    _ = sock.sendto(magic_packet, ("255.255.255.255", 9))
    if broadcast_ip and str(broadcast_ip).strip():
        for port in (9, 7):
            try:
                _ = sock.sendto(magic_packet, (str(broadcast_ip).strip(), port))
            except OSError:
                pass
    sock.close()


class TVConnection:
    COMMANDS: ClassVar[dict[str, tuple[str, JsonDict]]] = TV_COMMANDS

    name: str
    ip: str
    client_key: str | None
    use_ssl: bool
    ssl_cert_pem: str | None
    ssl_server_name: str | None
    ws: ClientConnection | None
    input_ws: ClientConnection | None
    msg_id: int
    connected: bool

    def __init__(
        self,
        name: str,
        ip: str,
        client_key: str | None,
        use_ssl: bool = True,
        ssl_cert_pem: str | None = None,
        ssl_server_name: str | None = None,
    ):
        self.name = name
        self.ip = ip
        self.client_key = client_key
        self.use_ssl = use_ssl
        self.ssl_cert_pem = ssl_cert_pem
        self.ssl_server_name = ssl_server_name
        self.ws = None
        self.input_ws = None
        self.msg_id = 0
        self.connected = False

    def _uri(self) -> str:
        protocol = "wss" if self.use_ssl else "ws"
        port = 3001 if self.use_ssl else 3000
        return f"{protocol}://{self.ip}:{port}"

    async def _ensure_ssl_pin(self) -> None:
        if self.ssl_cert_pem and self.ssl_server_name:
            return
        self.ssl_cert_pem = None
        self.ssl_server_name = None
        cert_pem, server_name = await asyncio.to_thread(_fetch_tv_ssl_pin, self.ip)
        self.ssl_cert_pem = cert_pem
        self.ssl_server_name = server_name

    def _clear_ssl_pin(self) -> None:
        self.ssl_cert_pem = None
        self.ssl_server_name = None

    async def _open_ssl_websocket(self, uri: str, *, close_timeout: float) -> ClientConnection:
        try:
            await self._ensure_ssl_pin()
        except Exception:
            pass
        return await asyncio.wait_for(
            websockets.connect(
                uri,
                ssl=get_ssl_context(),
                server_hostname=self.ssl_server_name or self.ip,
                close_timeout=close_timeout,
            ),
            timeout=5,
        )

    async def _connect_websocket(self, uri: str, *, close_timeout: float = 2) -> ClientConnection:
        if self.use_ssl:
            return await self._open_ssl_websocket(uri, close_timeout=close_timeout)
        return await asyncio.wait_for(
            websockets.connect(uri, close_timeout=close_timeout),
            timeout=5,
        )

    def _handshake_payload(self) -> JsonDict:
        handshake: JsonDict = copy.deepcopy(HANDSHAKE)
        if not self.client_key:
            return handshake
        payload = json_dict_get_dict(handshake, "payload")
        if payload is not None:
            payload["client-key"] = self.client_key
        return handshake

    def _registered_client_key(self, data: JsonDict) -> str | None:
        payload = json_dict_get_dict(data, "payload")
        if payload is None:
            return None
        client_key = payload.get("client-key")
        return client_key if isinstance(client_key, str) else None

    def _is_pairing_prompt(self, data: JsonDict) -> bool:
        if json_dict_get_str(data, "type") != "response":
            return False
        payload = json_dict_get_dict(data, "payload")
        return payload is not None and bool(payload.get("pairingType"))

    async def _wait_for_registration(self, initial_timeout: float) -> str | None:
        if not self.ws:
            raise RuntimeError("Not connected")

        timeout = initial_timeout
        while True:
            response = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            data = parse_json(response)
            msg_type = json_dict_get_str(data, "type")

            if msg_type == "registered":
                self.connected = True
                return self._registered_client_key(data)
            if self._is_pairing_prompt(data):
                timeout = 60
                continue
            if msg_type == "error":
                raise RuntimeError(json_dict_get_str(data, "error") or "Registration failed")

    async def connect(self) -> None:
        self.ws = await self._connect_websocket(self._uri())

        await self.ws.send(json.dumps(self._handshake_payload()))
        response = await asyncio.wait_for(self.ws.recv(), timeout=60)
        data = parse_json(response)

        if json_dict_get_str(data, "type") != "registered":
            raise RuntimeError(f"Registration failed: {data}")

        self.connected = True
        await self._connect_input_socket()

    async def register_only(self) -> str | None:
        """Connect, complete pairing, return new client-key if issued."""
        self.ws = await self._connect_websocket(self._uri())
        await self.ws.send(json.dumps(self._handshake_payload()))
        return await self._wait_for_registration(5 if self.client_key else 60)

    async def _connect_input_socket(self) -> None:
        response: JsonDict = await self.send_command(
            "ssap://com.webos.service.networkinput/getPointerInputSocket"
        )
        payload = json_dict_get_dict(response, "payload")
        socket_path = None
        if payload is not None:
            path = payload.get("socketPath")
            socket_path = path if isinstance(path, str) else None
        if not socket_path:
            return
        self.input_ws = await self._connect_websocket(socket_path)

    async def refresh_input_socket(self) -> None:
        if self.input_ws:
            try:
                await self.input_ws.close()
            except Exception:
                pass
            self.input_ws = None
        await self._connect_input_socket()

    async def keepalive_ping(self) -> bool:
        try:
            _ = await self.send_command("ssap://com.webos.service.connectionmanager/getinfo")
            return True
        except Exception:
            return False

    async def send_command(self, uri: str, payload: JsonDict | None = None) -> JsonDict:
        if not self.ws or not self.connected:
            raise RuntimeError("Not connected")

        self.msg_id += 1
        msg: JsonDict = {
            "type": "request",
            "id": f"cmd_{self.msg_id}",
            "uri": uri,
            "payload": payload or {},
        }
        await self.ws.send(json.dumps(msg))
        response = await asyncio.wait_for(self.ws.recv(), timeout=3)
        return parse_json(response)

    async def send_button(self, button: str) -> None:
        if not self.input_ws:
            await self._connect_input_socket()
        if not self.input_ws:
            raise RuntimeError("Input socket not available")

        cmd = f"type:button\nname:{button.upper()}\n\n"
        await self.input_ws.send(cmd)

    async def get_mac(self) -> str | None:
        try:
            info = await self.send_command("ssap://com.webos.service.connectionmanager/getinfo")
            payload = json_dict_get_dict(info, "payload") or {}
            wifi_info = json_dict_get_dict(payload, "wifiInfo") or {}
            wired_info = json_dict_get_dict(payload, "wiredInfo") or {}
            wifi_mac = json_dict_get_str(wifi_info, "macAddress")
            wired_mac = json_dict_get_str(wired_info, "macAddress")
            try:
                status = await self.send_command(
                    "ssap://com.webos.service.connectionmanager/getStatus"
                )
                sp = json_dict_get_dict(status, "payload") or {}
                wifi = json_dict_get_dict(sp, "wifi") or {}
                wifi_info_status = json_dict_get_dict(sp, "wifiInfo") or {}
                wired = json_dict_get_dict(sp, "wired") or {}
                wifi_connected = (
                    json_dict_get_str(wifi, "state") == "connected"
                    or json_dict_get_str(wifi_info_status, "state") == "connected"
                    or sp.get("isConnected") is True
                )
                wired_connected = json_dict_get_str(wired, "state") == "connected"
                if wired_connected and wired_mac:
                    return normalize_mac(wired_mac)
                if wifi_connected and wifi_mac:
                    return normalize_mac(wifi_mac)
            except Exception:
                pass
            return normalize_mac(wired_mac or wifi_mac)
        except Exception:
            return None

    async def volume_up(self) -> None:
        _ = await self.send_command("ssap://audio/volumeUp")

    async def volume_down(self) -> None:
        _ = await self.send_command("ssap://audio/volumeDown")

    async def set_mute(self, mute: bool) -> None:
        _ = await self.send_command("ssap://audio/setMute", {"mute": mute})

    async def power_off(self) -> None:
        _ = await self.send_command("ssap://system/turnOff")

    async def close(self) -> None:
        self.connected = False
        if self.input_ws:
            try:
                await self.input_ws.close()
            except Exception:
                pass
            self.input_ws = None
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
