"""Shared config file helpers for plasmoid CLI and daemon."""

from __future__ import annotations

import json
from pathlib import Path

from lgtv.types import JsonDict, parse_json

CONFIG_DIR = Path.home() / ".config" / "lgtv-remote"
CONFIG_FILE = CONFIG_DIR / "config.json"


def load_config() -> JsonDict:
    """Load saved TV configurations."""
    if CONFIG_FILE.exists():
        try:
            data = parse_json(CONFIG_FILE.read_text())
            if "streaming_device" not in data:
                data["streaming_device"] = None
            if "wake_streaming_on_power_on" not in data:
                data["wake_streaming_on_power_on"] = False
            if "active_tv" not in data:
                data["active_tv"] = None
            return data
        except Exception:
            pass
    return {
        "tvs": {},
        "streaming_device": None,
        "wake_streaming_on_power_on": False,
        "active_tv": None,
    }


def save_config(config: JsonDict) -> None:
    """Save TV configurations, preserving keys omitted from config."""
    current = load_config()
    for key in ("streaming_device", "wake_streaming_on_power_on", "active_tv"):
        if key not in config:
            config[key] = current.get(key)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _ = CONFIG_FILE.write_text(json.dumps(config, indent=2))
