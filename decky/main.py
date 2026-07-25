import asyncio
import importlib.util
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import cast

import decky

_PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_PLUGIN_DIR / "py_modules"))


def _load_lgtv_path_setup() -> Callable[[str | Path | None], Path]:
    module_path = _PLUGIN_DIR / "_lgtv_path.py"
    spec = importlib.util.spec_from_file_location("decky_lgtv_path", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast(Callable[[str | Path | None], Path], module.setup)


_ = _load_lgtv_path_setup()(_PLUGIN_DIR)

from settings import SettingsManager

from lgtv.tv import TVConnection, is_ssl_verify_error, wol_send
from lgtv.types import JsonDict, ResultDict, SettingsResultDict, TvSettingsDict

_NOT_CONNECTED = "Not connected"


def _ok(message: str | None = None) -> ResultDict:
    result: ResultDict = {"success": True}
    if message:
        result["message"] = message
    return result


def _err(error: str) -> ResultDict:
    return {"success": False, "error": error}


def _settings_response(settings: TvSettingsDict, message: str | None = None) -> SettingsResultDict:
    result: SettingsResultDict = {"success": True, **settings}
    if message:
        result["message"] = message
    return result


def _read_str_setting(settings: SettingsManager, key: str, default: str) -> str:
    value = cast(object, settings.getSetting(key, default))
    return value if isinstance(value, str) else default


def _read_bool_setting(settings: SettingsManager, key: str, default: bool) -> bool:
    value = cast(object, settings.getSetting(key, default))
    return value if isinstance(value, bool) else default


def _read_optional_str_setting(settings: SettingsManager, key: str) -> str | None:
    value = cast(object, settings.getSetting(key, None))
    return value if isinstance(value, str) else None


class Plugin:
    def __init__(self) -> None:
        self.tv: TVConnection | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self._settings: SettingsManager | None = None

    def _settings_mgr(self) -> SettingsManager:
        if self._settings is None:
            settings_dir = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "").strip()
            if not settings_dir:
                raise RuntimeError("DECKY_PLUGIN_SETTINGS_DIR is not set")
            self._settings = SettingsManager(
                name="settings",
                settings_directory=settings_dir,
            )
            decky.logger.info(f"LG TV Remote settings file: {self._settings.path}")
        return self._settings

    def _get_tv_settings(self) -> TvSettingsDict:
        settings = self._settings_mgr()
        settings.read()
        return {
            "tv_name": _read_str_setting(settings, "tv_name", "TV"),
            "tv_ip": _read_str_setting(settings, "tv_ip", ""),
            "use_ssl": _read_bool_setting(settings, "use_ssl", True),
            "client_key": _read_optional_str_setting(settings, "client_key"),
            "mac": _read_optional_str_setting(settings, "mac"),
            "ssl_cert_pem": _read_optional_str_setting(settings, "ssl_cert_pem"),
            "ssl_server_name": _read_optional_str_setting(settings, "ssl_server_name"),
        }

    def _write_settings(self, updates: JsonDict) -> None:
        settings = self._settings_mgr()
        settings.read()
        settings.settings.update(updates)
        settings.commit()
        decky.logger.info(
            f"Wrote settings to {settings.path}: tv_ip={settings.settings.get('tv_ip')!r}"
        )

    def _save_ssl_pin(self, tv: TVConnection) -> None:
        updates: JsonDict = {}
        if tv.ssl_cert_pem:
            updates["ssl_cert_pem"] = tv.ssl_cert_pem
        if tv.ssl_server_name:
            updates["ssl_server_name"] = tv.ssl_server_name
        if updates:
            self._write_settings(updates)

    async def _stop_keepalive(self) -> None:
        if self._keepalive_task:
            task = self._keepalive_task
            self._keepalive_task = None
            _ = task.cancel()
            await task

    async def _disconnect(self) -> None:
        await self._stop_keepalive()
        if self.tv:
            await self.tv.close()
            self.tv = None

    async def _keepalive_loop(self) -> None:
        while self.tv and self.tv.connected:
            await asyncio.sleep(25)
            if not self.tv or not self.tv.connected:
                break
            if not await self.tv.keepalive_ping():
                decky.logger.warning("LG TV keepalive failed, disconnecting")
                await self._disconnect()
                break
            try:
                await self.tv.refresh_input_socket()
            except Exception as exc:
                decky.logger.warning(f"Input socket refresh failed: {exc}")

    def _connected_settings(self) -> TvSettingsDict:
        data = self._get_tv_settings()
        data["connected"] = bool(self.tv and self.tv.connected)
        return data

    def _set_tv_ip_sync(self, tv_ip: str) -> SettingsResultDict | ResultDict:
        try:
            new_ip = (tv_ip or "").strip()
            if not new_ip:
                return _err("Enter a TV IP address")

            current = self._get_tv_settings()
            updates: JsonDict = {"tv_ip": new_ip}
            if new_ip != current.get("tv_ip", ""):
                updates["ssl_cert_pem"] = None
                updates["ssl_server_name"] = None
            self._write_settings(updates)
            return _settings_response(self._get_tv_settings(), "IP saved — tap Authenticate next")
        except Exception as exc:
            decky.logger.error(f"set_tv_ip failed: {exc}")
            return _err(f"Could not save IP: {exc}")

    def _set_tv_name_sync(self, tv_name: str) -> SettingsResultDict | ResultDict:
        try:
            name = (tv_name or "TV").strip() or "TV"
            self._write_settings({"tv_name": name})
            return _settings_response(self._get_tv_settings(), "Name saved")
        except Exception as exc:
            decky.logger.error(f"set_tv_name failed: {exc}")
            return _err(f"Could not save name: {exc}")

    def _set_use_ssl_sync(self, use_ssl: bool) -> SettingsResultDict | ResultDict:
        try:
            current = self._get_tv_settings()
            updates: JsonDict = {"use_ssl": bool(use_ssl)}
            if bool(use_ssl) != bool(current.get("use_ssl", True)):
                updates["ssl_cert_pem"] = None
                updates["ssl_server_name"] = None
            self._write_settings(updates)
            return _settings_response(self._get_tv_settings(), "SSL setting saved")
        except Exception as exc:
            decky.logger.error(f"set_use_ssl failed: {exc}")
            return _err(f"Could not save SSL setting: {exc}")

    def _save_settings_sync(
        self, tv_name: str, tv_ip: str, use_ssl: bool
    ) -> SettingsResultDict | ResultDict:
        try:
            new_ip = (tv_ip or "").strip()
            if not new_ip:
                return _err("Enter a TV IP address")

            current = self._get_tv_settings()
            updates: JsonDict = {
                "tv_name": (tv_name or "TV").strip() or "TV",
                "tv_ip": new_ip,
                "use_ssl": bool(use_ssl),
            }
            if new_ip != current.get("tv_ip", ""):
                updates["ssl_cert_pem"] = None
                updates["ssl_server_name"] = None
            self._write_settings(updates)
            return _settings_response(
                self._get_tv_settings(), "Settings saved — tap Authenticate next"
            )
        except Exception as exc:
            decky.logger.error(f"save_settings failed: {exc}")
            return _err(f"Could not save settings: {exc}")

    def _clear_ssl_settings(self) -> None:
        self._write_settings({"ssl_cert_pem": None, "ssl_server_name": None})

    def _handle_ssl_failure(self, exc: BaseException) -> ResultDict:
        detail = str(exc)
        if is_ssl_verify_error(exc) or "CERTIFICATE_VERIFY_FAILED" in detail.upper():
            try:
                self._clear_ssl_settings()
            except Exception as clear_exc:
                decky.logger.warning(f"Could not clear SSL pin: {clear_exc}")
            return _err(
                f"TV TLS connection failed: {detail}. "
                + "Try Authenticate again, or turn off Use SSL in settings.",
            )
        return _err(detail)

    def _require_connected(self) -> TVConnection | None:
        if not self.tv or not self.tv.connected:
            return None
        return self.tv

    async def get_settings(self) -> TvSettingsDict:
        return await asyncio.to_thread(self._connected_settings)

    async def set_tv_ip(self, tv_ip: str) -> SettingsResultDict | ResultDict:
        return await asyncio.to_thread(self._set_tv_ip_sync, tv_ip)

    async def set_tv_name(self, tv_name: str) -> SettingsResultDict | ResultDict:
        return await asyncio.to_thread(self._set_tv_name_sync, tv_name)

    async def set_use_ssl(self, use_ssl: bool) -> SettingsResultDict | ResultDict:
        return await asyncio.to_thread(self._set_use_ssl_sync, use_ssl)

    async def save_settings(
        self, tv_name: str, tv_ip: str, use_ssl: bool
    ) -> SettingsResultDict | ResultDict:
        return await asyncio.to_thread(self._save_settings_sync, tv_name, tv_ip, use_ssl)

    def _tv_from_settings(self, cfg: TvSettingsDict) -> TVConnection:
        return TVConnection(
            cfg.get("tv_name") or "TV",
            cfg.get("tv_ip", ""),
            cfg.get("client_key"),
            cfg.get("use_ssl", True),
            cfg.get("ssl_cert_pem"),
            cfg.get("ssl_server_name"),
        )

    @staticmethod
    def _pairing_updates(tv: TVConnection, new_key: str | None, mac: str | None) -> JsonDict:
        updates: JsonDict = {}
        if new_key:
            updates["client_key"] = new_key
        if mac:
            updates["mac"] = mac
        if tv.ssl_cert_pem:
            updates["ssl_cert_pem"] = tv.ssl_cert_pem
        if tv.ssl_server_name:
            updates["ssl_server_name"] = tv.ssl_server_name
        return updates

    @staticmethod
    def _pairing_message(mac: str | None) -> str:
        msg = "Paired successfully."
        if mac:
            return f"{msg} MAC saved: {mac}"
        return f"{msg} MAC not found — Power On may not work."

    async def _register_tv(self, tv: TVConnection) -> ResultDict:
        new_key = await tv.register_only()
        mac = await tv.get_mac()
        updates = self._pairing_updates(tv, new_key, mac)
        if updates:
            self._write_settings(updates)
        return _ok(self._pairing_message(mac))

    def _clear_ssl_for_auth_retry(self, exc: BaseException, attempt: int) -> bool:
        if attempt != 0:
            return False
        detail = str(exc)
        if not (is_ssl_verify_error(exc) or "CERTIFICATE_VERIFY_FAILED" in detail.upper()):
            return False
        try:
            self._clear_ssl_settings()
        except Exception as clear_exc:
            decky.logger.warning(f"Could not clear SSL pin: {clear_exc}")
        return True

    async def authenticate(self) -> ResultDict:
        for attempt in range(2):
            cfg = self._get_tv_settings()
            if not cfg.get("tv_ip", ""):
                return _err("Set TV IP address first")

            tv = self._tv_from_settings(cfg)
            try:
                return await self._register_tv(tv)
            except Exception as exc:
                decky.logger.error(f"Authenticate failed (attempt {attempt + 1}): {exc}")
                if self._clear_ssl_for_auth_retry(exc, attempt):
                    continue
                return self._handle_ssl_failure(exc)
            finally:
                await tv.close()
        return _err("TV certificate verification failed after retry")

    async def connect(self) -> ResultDict:
        cfg = self._get_tv_settings()
        tv_ip = cfg.get("tv_ip", "")
        if not tv_ip:
            return _err("Set TV IP address first")

        await self._disconnect()

        self.tv = self._tv_from_settings(cfg)
        try:
            await self.tv.connect()
            self._save_ssl_pin(self.tv)
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())
            return _ok("Connected")
        except Exception as exc:
            await self._disconnect()
            decky.logger.error(f"Connect failed: {exc}")
            return self._handle_ssl_failure(exc)

    async def disconnect(self) -> ResultDict:
        await self._disconnect()
        return _ok("Disconnected")

    async def get_status(self) -> dict[str, bool]:
        await asyncio.sleep(0)
        return {"connected": bool(self.tv and self.tv.connected)}

    async def send_button(self, button: str) -> ResultDict:
        tv = self._require_connected()
        if not tv:
            return _err(_NOT_CONNECTED)
        try:
            await tv.send_button(button)
            return _ok()
        except Exception as exc:
            return _err(str(exc))

    async def volume_up(self) -> ResultDict:
        tv = self._require_connected()
        if not tv:
            return _err(_NOT_CONNECTED)
        try:
            await tv.volume_up()
            return _ok()
        except Exception as exc:
            return _err(str(exc))

    async def volume_down(self) -> ResultDict:
        tv = self._require_connected()
        if not tv:
            return _err(_NOT_CONNECTED)
        try:
            await tv.volume_down()
            return _ok()
        except Exception as exc:
            return _err(str(exc))

    async def set_mute(self, mute: bool) -> ResultDict:
        tv = self._require_connected()
        if not tv:
            return _err(_NOT_CONNECTED)
        try:
            await tv.set_mute(bool(mute))
            return _ok()
        except Exception as exc:
            return _err(str(exc))

    async def power_off(self) -> ResultDict:
        tv = self._require_connected()
        if not tv:
            return _err(_NOT_CONNECTED)
        try:
            await tv.power_off()
            return _ok("TV powered off")
        except Exception as exc:
            return _err(str(exc))

    async def power_on(self) -> ResultDict:
        cfg = self._get_tv_settings()
        mac = cfg.get("mac")
        if not mac:
            return _err("MAC not saved. Pair while the TV is on to save it.")
        try:
            await asyncio.to_thread(wol_send, mac)
            return _ok("Wake-on-LAN sent")
        except Exception as exc:
            return _err(str(exc))

    async def _main(self) -> None:
        self.loop = asyncio.get_running_loop()
        await asyncio.sleep(0)
        decky.logger.info("LG TV Remote plugin loaded")

    async def _unload(self) -> None:
        await self._disconnect()
        decky.logger.info("LG TV Remote plugin unloaded")
