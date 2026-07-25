"""Bootstrap lgtv imports for plasmoid scripts run as standalone files."""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Callable
from pathlib import Path
from typing import cast

_LgtvPathSetup = Callable[[str | Path | None], Path]


def setup_lgtv_imports(anchor: str | Path) -> Path:
    """Load _lgtv_path and add the lgtv package to sys.path."""
    path_file = Path(__file__).resolve().parent / "_lgtv_path.py"
    spec = importlib.util.spec_from_file_location("_lgtv_path", path_file)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path_file}")

    mod = importlib.util.module_from_spec(spec)
    _ = sys.modules.setdefault(spec.name, mod)
    spec.loader.exec_module(mod)

    setup_fn = cast(_LgtvPathSetup, mod.setup)
    return setup_fn(anchor)
