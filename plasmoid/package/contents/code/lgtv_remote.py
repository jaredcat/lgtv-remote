#!/usr/bin/env python3
"""
LG TV Remote - WebOS TV Controller
CLI for one-shot TV commands (auth, send, wol, list).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NoReturn, TypeAlias, cast

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
from lgtv.tv import TV_BUTTONS, TV_COMMANDS, TVConnection, wol_send
from lgtv.types import (
    JsonDict,
    as_streaming_device,
    json_dict_get_dict,
    json_dict_get_str,
)


def _tv_settings(name: str) -> tuple[str | None, str | None, str | None, str | None]:
    config = load_config()
    tvs = json_dict_get_dict(config, "tvs") or {}
    tv_cfg = json_dict_get_dict(tvs, name) or {}
    return (
        json_dict_get_str(tv_cfg, "client_key"),
        json_dict_get_str(tv_cfg, "ssl_cert_pem"),
        json_dict_get_str(tv_cfg, "ssl_server_name"),
        json_dict_get_str(tv_cfg, "ip"),
    )


def _persist_tv_settings(
    name: str,
    ip: str,
    *,
    client_key: str | None = None,
    ssl_cert_pem: str | None = None,
    ssl_server_name: str | None = None,
    mac: str | None = None,
) -> None:
    config = load_config()
    tvs = json_dict_get_dict(config, "tvs")
    if tvs is None:
        tvs = {}
        config["tvs"] = tvs
    tv_cfg = json_dict_get_dict(tvs, name)
    if tv_cfg is None:
        tv_cfg = {}
        tvs[name] = tv_cfg
    tv_cfg["ip"] = ip
    if client_key is not None:
        tv_cfg["client_key"] = client_key
    if ssl_cert_pem is not None:
        tv_cfg["ssl_cert_pem"] = ssl_cert_pem
    if ssl_server_name is not None:
        tv_cfg["ssl_server_name"] = ssl_server_name
    if mac is not None:
        tv_cfg["mac"] = mac
    save_config(config)


async def run_command(
    ip: str,
    name: str,
    command: str,
    args: list[str] | None = None,
    use_ssl: bool = True,
) -> JsonDict:
    """Run a command on the TV."""
    if command == "on":
        return wake_on_lan_async(name)

    client_key, ssl_cert_pem, ssl_server_name, _ = _tv_settings(name)
    client = TVConnection(
        name,
        ip,
        client_key,
        use_ssl,
        ssl_cert_pem,
        ssl_server_name,
    )

    try:
        await client.connect()

        if command == "sendButton":
            button = args[0].upper() if args else "ENTER"
            if button not in TV_BUTTONS:
                return {"success": False, "error": f"Unknown button: {button}"}
            await client.send_button(button)
            result: JsonDict = {"success": True}

        elif command == "mute":
            mute_value = True
            if args and args[0].lower() in ("false", "0", "off"):
                mute_value = False
            result = await client.send_command("ssap://audio/setMute", {"mute": mute_value})
            return {"success": True, "result": result, "muted": mute_value}

        elif command in TV_COMMANDS:
            uri, payload = TV_COMMANDS[command]
            result = await client.send_command(uri, payload)

        else:
            return {"success": False, "error": f"Unknown command: {command}"}

        return {"success": True, "result": result}

    except Exception as e:
        return {"success": False, "error": str(e)}

    finally:
        await client.close()


def wake_on_lan_async(name: str) -> JsonDict:
    """Send Wake-on-LAN magic packet to turn on TV. Optionally wake streaming device too."""
    config = load_config()
    tvs = json_dict_get_dict(config, "tvs") or {}
    tv_config = json_dict_get_dict(tvs, name) or {}
    mac = json_dict_get_str(tv_config, "mac")

    if not mac:
        return {
            "success": False,
            "error": "MAC address not saved. Turn TV on, run Auth to save MAC.",
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


async def authenticate(ip: str, name: str, use_ssl: bool = True) -> JsonDict:
    """Authenticate with a TV (triggers pairing prompt) and save MAC for WoL."""
    client_key, ssl_cert_pem, ssl_server_name, _ = _tv_settings(name)
    client = TVConnection(name, ip, client_key, use_ssl, ssl_cert_pem, ssl_server_name)

    try:
        new_key = await client.register_only()
        _persist_tv_settings(
            name,
            ip,
            client_key=new_key or client_key,
            ssl_cert_pem=client.ssl_cert_pem,
            ssl_server_name=client.ssl_server_name,
        )

        mac = await client.get_mac()
        if mac:
            _persist_tv_settings(name, ip, mac=mac)

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


def wake_on_lan(mac_address: str) -> JsonDict:
    """Send Wake-on-LAN magic packet."""
    try:
        wol_send(mac_address, None)
        return {"success": True, "message": "Wake-on-LAN packet sent"}
    except Exception as e:
        return {"success": False, "error": f"WoL failed: {e}"}


CliHandler: TypeAlias = Callable[[], JsonDict]


def _print_cli_result(result: JsonDict) -> None:
    print(json.dumps(result))


def _cli_fail(error: str) -> NoReturn:
    _print_cli_result({"success": False, "error": error})
    sys.exit(1)


def _use_ssl_from_argv() -> bool:
    return "--no-ssl" not in sys.argv


def _tv_ip_for_name(name: str) -> str | None:
    _, _, _, ip = _tv_settings(name)
    return ip


def _cmd_auth() -> JsonDict:
    if len(sys.argv) < 4:
        _cli_fail("Usage: auth <ip> <name> [--ssl/--no-ssl]")
    return asyncio.run(authenticate(sys.argv[2], sys.argv[3], _use_ssl_from_argv()))


def _cmd_send() -> JsonDict:
    if len(sys.argv) < 4:
        _cli_fail("Usage: send <name> <command> [args] [--ssl/--no-ssl]")
    name = sys.argv[2]
    cmd = sys.argv[3]
    args = (
        sys.argv[4].split(",")
        if len(sys.argv) > 4 and sys.argv[4] and sys.argv[4] not in ("--no-ssl", "--ssl", "")
        else []
    )
    ip = _tv_ip_for_name(name)
    if not ip:
        _cli_fail(f"TV '{name}' not found. Run auth first.")
    return asyncio.run(run_command(ip, name, cmd, args, _use_ssl_from_argv()))


def _cmd_wol() -> JsonDict:
    if len(sys.argv) < 3:
        _cli_fail("Usage: wol <mac_address>")
    return wake_on_lan(sys.argv[2])


def _cmd_list() -> JsonDict:
    config = load_config()
    tvs = json_dict_get_dict(config, "tvs") or {}
    return {"success": True, "tvs": list(tvs.keys())}


def main() -> None:
    if len(sys.argv) < 2:
        _cli_fail("Usage: lgtv_remote.py <command> [args...]")

    handlers: dict[str, CliHandler] = {
        "auth": _cmd_auth,
        "send": _cmd_send,
        "wol": _cmd_wol,
        "list": _cmd_list,
    }
    handler = handlers.get(sys.argv[1])
    if handler is None:
        _cli_fail(f"Unknown command: {sys.argv[1]}")
    _print_cli_result(handler())


if __name__ == "__main__":
    main()
