"""Wake streaming devices (WoL, ADB, Roku)."""

from __future__ import annotations

import socket
import subprocess

from lgtv.tv import wol_send
from lgtv.types import StreamingDeviceDict


def wake_streaming_device(device: StreamingDeviceDict) -> None:
    """Wake a streaming device (WoL, ADB, or Roku)."""
    kind = device.get("type", "").lower()
    if kind == "wol":
        mac = device.get("mac")
        if mac:
            wol_send(mac, device.get("broadcast_ip"))
    elif kind == "adb":
        ip = device.get("ip")
        port = device.get("port", 5555)
        if ip:
            try:
                _ = subprocess.run(
                    ["adb", "connect", f"{ip}:{port}"], capture_output=True, timeout=10
                )
                _ = subprocess.run(
                    ["adb", "-s", f"{ip}:{port}", "shell", "input", "keyevent", "KEYCODE_WAKEUP"],
                    capture_output=True,
                    timeout=10,
                )
            except Exception:
                pass
    elif kind == "roku":
        ip = device.get("ip")
        if ip:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(3)
                s.connect((ip, 8060))
                s.sendall(
                    (
                        f"POST /keypress/PowerOn HTTP/1.1\r\nHost: {ip}\r\n"
                        + "Content-Length: 0\r\nConnection: close\r\n\r\n"
                    ).encode()
                )
                s.close()
            except Exception:
                pass
