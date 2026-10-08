#!/usr/bin/env python3
"""
LG TV Remote Daemon
Maintains a persistent WebSocket connection to the TV for fast command execution.
Listens on a Unix socket for commands from the Plasma widget.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import os
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeAlias, cast

_SetupLgtvImports = Callable[[str | Path], Path]

_bootstrap_spec = importlib.util.spec_from_file_location(
    "_lgtv_bootstrap",
    Path(__file__).resolve().parent / "_bootstrap.py",
)
if _bootstrap_spec is None or _bootstrap_spec.loader is None:
    raise ImportError("Cannot load _bootstrap.py")
_bootstrap = importlib.util.module_from_spec(_bootstrap_spec)
_bootstrap_spec.loader.exec_module(_bootstrap)
_ = cast(_SetupLgtvImports, _bootstrap.setup_lgtv_imports)(__file__)

from lgtv.config import load_config, save_config
from lgtv.streaming import wake_streaming_device
from lgtv.tv import TVConnection, normalize_mac, wol_send
from lgtv.types import (
    JsonDict,
    JsonValue,
    as_streaming_device,
    json_dict_get_dict,
    json_dict_get_str,
    parse_json,
)


def _daemon_runtime_dir() -> Path:
    """Return a private runtime directory for the daemon socket and PID file."""
    xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
    if xdg_runtime:
        path = Path(xdg_runtime)
        if path.is_dir() and os.access(path, os.W_OK | os.X_OK):
            return path

    path = Path.home() / ".cache" / "lgtv-remote" / "run"
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


# Socket paths
RUNTIME_DIR = _daemon_runtime_dir()
SOCKET_PATH = RUNTIME_DIR / "lgtv-remote.sock"
PID_FILE = RUNTIME_DIR / "lgtv-remote.pid"

ExecuteHandler: TypeAlias = Callable[[list[str] | None], JsonDict | Awaitable[JsonDict]]
ClientCommandHandler: TypeAlias = Callable[[JsonDict], JsonDict | Awaitable[JsonDict]]


def _request_args(request: JsonDict) -> list[str] | None:
    args = request.get("args", [])
    if not isinstance(args, list):
        return None
    return [arg for arg in args if isinstance(arg, str)]


async def _write_json_response(writer: asyncio.StreamWriter, response: JsonDict) -> None:
    writer.write((json.dumps(response) + "\n").encode())
    await writer.drain()


class DaemonTVConnection(TVConnection):
    """Persistent TV connection with daemon command dispatch."""

    async def _execute_send_button(self, args: list[str] | None) -> JsonDict:
        button = args[0] if args else "ENTER"
        await self.send_button(button)
        return {"success": True}

    async def _execute_mute(self, args: list[str] | None) -> JsonDict:
        mute_value = True
        if args and args[0].lower() in ("false", "0", "off"):
            mute_value = False
        result = await self.send_command("ssap://audio/setMute", {"mute": mute_value})
        return {"success": True, "result": result, "muted": mute_value}

    async def _execute_power_on(self, _args: list[str] | None) -> JsonDict:
        return await self.wake_on_lan()

    def _execute_wake_streaming_device(self, _args: list[str] | None) -> JsonDict:
        config = load_config()
        device = as_streaming_device(config.get("streaming_device"))
        if not device:
            return {"success": False, "error": "No streaming device configured"}
        wake_streaming_device(device)
        return {"success": True, "message": "Wake sent"}

    def _save_mac_to_config(self, mac: str) -> JsonDict:
        config = load_config()
        tvs = json_dict_get_dict(config, "tvs")
        if tvs is None:
            tvs = {}
            config["tvs"] = tvs
        tv = json_dict_get_dict(tvs, self.name)
        if tv is None:
            tv = {}
            tvs[self.name] = tv
        tv["mac"] = mac
        save_config(config)
        return {"success": True, "message": f"MAC address saved: {mac}"}

    async def _execute_fetch_mac(self, _args: list[str] | None) -> JsonDict:
        mac = await self.get_mac()
        if not mac:
            return {"success": False, "error": "Could not get MAC from TV"}
        return self._save_mac_to_config(mac)

    async def _execute_builtin_command(self, command: str) -> JsonDict:
        uri, payload = self.COMMANDS[command]
        result = await self.send_command(uri, payload)
        return {"success": True, "result": result}

    async def _run_execute(self, command: str, args: list[str] | None) -> JsonDict:
        dispatch: dict[str, ExecuteHandler] = {
            "sendButton": self._execute_send_button,
            "mute": self._execute_mute,
            "on": self._execute_power_on,
            "wake_streaming_device": self._execute_wake_streaming_device,
            "fetch_mac": self._execute_fetch_mac,
        }
        handler = dispatch.get(command)
        if handler is not None:
            result = handler(args)
            if inspect.isawaitable(result):
                return await result
            return result
        if command in self.COMMANDS:
            return await self._execute_builtin_command(command)
        return {"success": False, "error": f"Unknown command: {command}"}

    async def execute(self, command: str, args: list[str] | None = None) -> JsonDict:
        try:
            return await self._run_execute(command, args)
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def wake_on_lan(self) -> JsonDict:
        config = load_config()
        tvs = json_dict_get_dict(config, "tvs") or {}
        tv_config = json_dict_get_dict(tvs, self.name) or {}
        mac = json_dict_get_str(tv_config, "mac")

        if not mac:
            try:
                _ = await self.send_command("ssap://system/getSystemInfo")
                return {"success": True, "message": "TV is already on"}
            except Exception:
                return {
                    "success": False,
                    "error": (
                        "MAC address not saved. Turn TV on manually first, "
                        "then use 'Auth' to save MAC."
                    ),
                }

        try:
            wol_send(mac, None)
            if config.get("wake_streaming_on_power_on"):
                device = as_streaming_device(config.get("streaming_device"))
                if device:
                    wake_streaming_device(device)
            return {"success": True, "message": "Wake-on-LAN packet sent"}
        except Exception as e:
            return {"success": False, "error": f"WoL failed: {e}"}


def _tv_cfg_field(tv_cfg: JsonDict | None, key: str) -> str | None:
    return json_dict_get_str(tv_cfg, key) if tv_cfg else None


def _connect_params_from_request(
    request: JsonDict,
) -> tuple[str | None, str | None, bool, str | None, str | None, str | None]:
    name = json_dict_get_str(request, "name")
    ip = json_dict_get_str(request, "ip")
    use_ssl_raw = request.get("ssl", True)
    use_ssl = use_ssl_raw if isinstance(use_ssl_raw, bool) else True

    config = load_config()
    tvs = json_dict_get_dict(config, "tvs") or {}
    tv_cfg = json_dict_get_dict(tvs, name) if name else None

    return (
        name,
        ip,
        use_ssl,
        _tv_cfg_field(tv_cfg, "client_key"),
        _tv_cfg_field(tv_cfg, "ssl_cert_pem"),
        _tv_cfg_field(tv_cfg, "ssl_server_name"),
    )


def _persist_ssl_pin(name: str | None, tv: DaemonTVConnection) -> None:
    if not name or not (tv.ssl_cert_pem or tv.ssl_server_name):
        return

    config = load_config()
    tvs = json_dict_get_dict(config, "tvs") or {}
    tv_cfg = json_dict_get_dict(tvs, name)
    if tv_cfg is None:
        return

    if tv.ssl_cert_pem:
        tv_cfg["ssl_cert_pem"] = tv.ssl_cert_pem
    if tv.ssl_server_name:
        tv_cfg["ssl_server_name"] = tv.ssl_server_name
    save_config(config)


async def _disconnect_keepalive_tv(daemon: Daemon) -> None:
    if daemon.tv:
        await daemon.tv.close()
        daemon.tv = None


async def _refresh_input_socket_with_retry(daemon: Daemon) -> None:
    if not daemon.tv or not daemon.tv.connected:
        return
    try:
        await daemon.tv.refresh_input_socket()
    except Exception as e:
        print(f"Keepalive: refresh input socket failed: {e}", file=sys.stderr)
        await asyncio.sleep(3)
        if daemon.tv and daemon.tv.connected:
            try:
                await daemon.tv.refresh_input_socket()
            except Exception:
                pass


async def keepalive_loop(daemon: Daemon, interval_secs: int = 25) -> None:
    """Ping TV every interval_secs while connected; refresh input socket; on failure disconnect."""
    while daemon.running and daemon.tv and daemon.tv.connected:
        await asyncio.sleep(interval_secs)
        tv = daemon.tv
        if not tv or not tv.connected:
            break
        ok = await tv.keepalive_ping()
        if not ok:
            await _disconnect_keepalive_tv(daemon)
            break
        await _refresh_input_socket_with_retry(daemon)


class Daemon:
    """Daemon that handles commands from the widget."""

    tv: DaemonTVConnection | None
    running: bool
    _keepalive_task: asyncio.Task[None] | None

    def __init__(self) -> None:
        self.tv = None
        self.running = False
        self._keepalive_task = None

    async def _cancel_keepalive_task(self) -> None:
        task = self._keepalive_task
        self._keepalive_task = None
        if not task:
            return
        _ = task.cancel()
        _ = await asyncio.gather(task, return_exceptions=True)

    async def _close_tv_connection(self) -> None:
        if self.tv:
            await self.tv.close()
            self.tv = None

    async def _handle_connect(self, request: JsonDict) -> JsonDict:
        name, ip, use_ssl, client_key, ssl_cert_pem, ssl_server_name = _connect_params_from_request(
            request
        )

        await self._cancel_keepalive_task()
        await self._close_tv_connection()

        self.tv = DaemonTVConnection(
            name or "",
            ip or "",
            client_key,
            use_ssl,
            ssl_cert_pem,
            ssl_server_name,
        )
        try:
            await self.tv.connect()
            _persist_ssl_pin(name, self.tv)
            self._keepalive_task = asyncio.create_task(keepalive_loop(self))
            return {"success": True, "message": "Connected"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _handle_disconnect(self, _request: JsonDict) -> JsonDict:
        await self._cancel_keepalive_task()
        await self._close_tv_connection()
        return {"success": True}

    def _handle_status(self, _request: JsonDict) -> JsonDict:
        return {"success": True, "connected": self.tv.connected if self.tv else False}

    def _handle_getconfig(self, _request: JsonDict) -> JsonDict:
        return {"success": True, "config": load_config()}

    def _handle_set_streaming_device(self, request: JsonDict) -> JsonDict:
        config = load_config()
        config["streaming_device"] = request.get("device")
        save_config(config)
        return {"success": True}

    def _handle_set_wake_streaming_on_power_on(self, request: JsonDict) -> JsonDict:
        enabled = request.get("enabled", False)
        config = load_config()
        config["wake_streaming_on_power_on"] = bool(enabled)
        save_config(config)
        return {"success": True}

    def _handle_set_mac(self, request: JsonDict) -> JsonDict:
        mac_raw = json_dict_get_str(request, "mac")
        mac = (mac_raw or "").strip()
        if not mac or len(mac.replace(":", "").replace("-", "").replace(" ", "")) != 12:
            return {"success": False, "error": "Invalid MAC address"}

        name = json_dict_get_str(request, "name")
        config = load_config()
        tvs = json_dict_get_dict(config, "tvs")
        if not name or tvs is None or name not in tvs:
            return {"success": False, "error": "TV not found"}

        tv_cfg = json_dict_get_dict(tvs, name)
        if tv_cfg is None:
            tv_cfg = {}
            tvs[name] = tv_cfg
        tv_cfg["mac"] = normalize_mac(mac) or mac
        save_config(config)
        saved_mac = json_dict_get_str(tv_cfg, "mac") or mac
        return {"success": True, "message": f"MAC set to {saved_mac}"}

    def _handle_stop(self, _request: JsonDict) -> JsonDict:
        self.running = False
        return {"success": True, "message": "Stopping daemon"}

    async def _dispatch_client_command(self, cmd: str, request: JsonDict) -> JsonDict:
        handlers: dict[str, ClientCommandHandler] = {
            "connect": self._handle_connect,
            "disconnect": self._handle_disconnect,
            "status": self._handle_status,
            "getconfig": self._handle_getconfig,
            "set_streaming_device": self._handle_set_streaming_device,
            "set_wake_streaming_on_power_on": self._handle_set_wake_streaming_on_power_on,
            "set_mac": self._handle_set_mac,
            "stop": self._handle_stop,
        }
        handler = handlers.get(cmd)
        if handler is not None:
            result = handler(request)
            if inspect.isawaitable(result):
                return await result
            return result
        if self.tv and self.tv.connected:
            return await self.tv.execute(cmd, _request_args(request))
        return {"success": False, "error": "Not connected to TV"}

    async def handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle a command from the widget."""
        try:
            data = await asyncio.wait_for(reader.readline(), timeout=5)
            if not data:
                return

            request = parse_json(data.decode().strip())
            cmd = json_dict_get_str(request, "cmd")
            if not cmd:
                response: JsonDict = {"success": False, "error": "Missing cmd"}
            else:
                response = await self._dispatch_client_command(cmd, request)

            await _write_json_response(writer, response)
        except TimeoutError:
            pass
        except Exception as e:
            try:
                await _write_json_response(writer, {"success": False, "error": str(e)})
            except Exception:
                pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def run(self):
        """Run the daemon."""
        # Remove old socket
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()

        # Write PID file
        _ = PID_FILE.write_text(str(os.getpid()))

        self.running = True
        server = await asyncio.start_unix_server(self.handle_client, path=str(SOCKET_PATH))

        # Make socket accessible
        os.chmod(SOCKET_PATH, 0o600)

        print(f"Daemon listening on {SOCKET_PATH}", file=sys.stderr)

        async with server:
            while self.running:
                await asyncio.sleep(0.1)

        # Cleanup
        if self.tv:
            await self.tv.close()
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()
        if PID_FILE.exists():
            PID_FILE.unlink()


async def send_to_daemon(request: JsonDict) -> JsonDict:
    """Send a request to the daemon."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(path=str(SOCKET_PATH)), timeout=1
        )
        writer.write((json.dumps(request) + "\n").encode())
        await writer.drain()

        response = await asyncio.wait_for(reader.readline(), timeout=5)
        writer.close()
        await writer.wait_closed()

        return parse_json(response.decode().strip())
    except FileNotFoundError:
        return {"success": False, "error": "Daemon not running"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def is_daemon_running():
    """Check if daemon is running."""
    if not PID_FILE.exists():
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)  # Check if process exists
        return True
    except (ProcessLookupError, ValueError):
        # Clean up stale files
        if PID_FILE.exists():
            PID_FILE.unlink()
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()
        return False


CliHandler: TypeAlias = Callable[[], None]


def _print_json_response(result: JsonDict) -> None:
    print(json.dumps(result))


def _daemon_cli_request(cmd: str, args: list[str] | None = None, **extra: JsonValue) -> JsonDict:
    request: JsonDict = {"cmd": cmd, **extra}
    if args:
        request["args"] = cast(JsonValue, args)
    return request


def _print_usage() -> None:
    print("Usage: lgtv_daemon.py <command> [args...]")
    print("Commands: start, stop, status, connect, send, ...")


def _cmd_start() -> None:
    if is_daemon_running():
        _print_json_response({"success": False, "error": "Daemon already running"})
        sys.exit(0)

    if os.fork() > 0:
        sys.exit(0)

    os.setsid()
    if os.fork() > 0:
        sys.exit(0)

    sys.stdin = open(os.devnull)
    sys.stdout = open(os.devnull, "w")

    daemon = Daemon()
    asyncio.run(daemon.run())


def _cmd_stop() -> None:
    result = asyncio.run(send_to_daemon({"cmd": "stop"}))
    _print_json_response(result)


def _cmd_status() -> None:
    if not is_daemon_running():
        _print_json_response({"success": True, "running": False})
        return
    result = asyncio.run(send_to_daemon({"cmd": "status"}))
    result["running"] = True
    _print_json_response(result)


def _cmd_connect() -> None:
    if len(sys.argv) < 4:
        _print_json_response({"success": False, "error": "Usage: connect <name> <ip> [--no-ssl]"})
        sys.exit(1)

    request: JsonDict = {
        "cmd": "connect",
        "name": sys.argv[2],
        "ip": sys.argv[3],
        "ssl": "--no-ssl" not in sys.argv,
    }
    _print_json_response(asyncio.run(send_to_daemon(request)))


def _cmd_send() -> None:
    if len(sys.argv) < 3:
        _print_json_response({"success": False, "error": "Usage: send <command> [args...]"})
        sys.exit(1)

    args = sys.argv[3].split(",") if len(sys.argv) > 3 and sys.argv[3] else []
    _print_json_response(asyncio.run(send_to_daemon(_daemon_cli_request(sys.argv[2], args))))


def _cmd_getconfig() -> None:
    if not is_daemon_running():
        _print_json_response({"success": False, "error": "Daemon not running"})
        return
    _print_json_response(asyncio.run(send_to_daemon({"cmd": "getconfig"})))


def _cmd_setconfig() -> None:
    if len(sys.argv) < 4:
        _print_json_response({"success": False, "error": "Usage: setconfig <key> <value>"})
        sys.exit(1)

    key = sys.argv[2]
    val = sys.argv[3]
    result: JsonDict
    if key == "streaming_device":
        device = parse_json(val) if val else None
        request: JsonDict = {"cmd": "set_streaming_device", "device": device}
        result = asyncio.run(send_to_daemon(request))
    elif key == "wake_streaming_on_power_on":
        request = {"cmd": "set_wake_streaming_on_power_on"}
        request["enabled"] = val.lower() == "true"
        result = asyncio.run(send_to_daemon(request))
    else:
        result = {"success": False, "error": "Unknown config key"}
    _print_json_response(result)


def _cmd_setmac() -> None:
    if len(sys.argv) < 4:
        _print_json_response({"success": False, "error": "Usage: setmac <name> <mac>"})
        sys.exit(1)

    request: JsonDict = {"cmd": "set_mac", "name": sys.argv[2], "mac": sys.argv[3]}
    _print_json_response(asyncio.run(send_to_daemon(request)))


def _cmd_direct(command: str) -> None:
    args = sys.argv[2].split(",") if len(sys.argv) > 2 and sys.argv[2] else []
    _print_json_response(asyncio.run(send_to_daemon(_daemon_cli_request(command, args))))


def main() -> None:
    if len(sys.argv) < 2:
        _print_usage()
        sys.exit(1)

    command = sys.argv[1]
    handlers: dict[str, CliHandler] = {
        "start": _cmd_start,
        "stop": _cmd_stop,
        "status": _cmd_status,
        "connect": _cmd_connect,
        "send": _cmd_send,
        "getconfig": _cmd_getconfig,
        "setconfig": _cmd_setconfig,
        "setmac": _cmd_setmac,
    }
    handler = handlers.get(command)
    if handler is not None:
        handler()
    else:
        _cmd_direct(command)


if __name__ == "__main__":
    main()
