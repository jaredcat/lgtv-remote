"""Shared JSON and API types for LG TV remote Python code."""

from __future__ import annotations

import json
from typing import Literal, TypeAlias, TypedDict, cast

JsonValue: TypeAlias = bool | int | float | str | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonDict: TypeAlias = dict[str, JsonValue]


class WolDeviceDict(TypedDict, total=False):
    type: Literal["wol"]
    mac: str
    broadcast_ip: str


class AdbDeviceDict(TypedDict, total=False):
    type: Literal["adb"]
    ip: str
    port: int


class RokuDeviceDict(TypedDict, total=False):
    type: Literal["roku"]
    ip: str


StreamingDeviceDict: TypeAlias = WolDeviceDict | AdbDeviceDict | RokuDeviceDict
Device: TypeAlias = StreamingDeviceDict


def as_streaming_device(value: JsonValue) -> StreamingDeviceDict | None:
    if not isinstance(value, dict):
        return None
    return cast(StreamingDeviceDict, cast(object, value))


def parse_json(text: str | bytes) -> JsonDict:
    return cast(JsonDict, json.loads(text))


def json_dict_get_dict(data: JsonDict, key: str) -> JsonDict | None:
    value = data.get(key)
    return value if isinstance(value, dict) else None


def json_dict_get_str(data: JsonDict, key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None


class ResultDict(TypedDict, total=False):
    success: bool
    message: str
    error: str


class TvSettingsDict(TypedDict, total=False):
    tv_name: str
    tv_ip: str
    use_ssl: bool
    client_key: str | None
    mac: str | None
    ssl_cert_pem: str | None
    ssl_server_name: str | None
    connected: bool


class SettingsResultDict(TvSettingsDict, ResultDict):
    pass
