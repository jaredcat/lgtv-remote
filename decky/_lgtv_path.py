"""Add the project root to sys.path so `import lgtv` works."""

from __future__ import annotations

import sys
from pathlib import Path


def _has_lgtv_package(root: Path) -> bool:
    return (root / "lgtv" / "tv.py").is_file()


def _unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        unique.append(path)
    return unique


def _search_roots(here: Path) -> list[Path]:
    roots = [here]
    if here.name == "code":
        roots.append(here.parent)
    roots.append(here.parent)

    candidates = _unique_paths(roots)
    seen = set(candidates)
    for parent in here.parents:
        if not _has_lgtv_package(parent):
            continue
        if parent not in seen:
            candidates.append(parent)
        break
    return candidates


def _prepend_sys_path(root: Path) -> None:
    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def setup(anchor: str | Path | None = None) -> Path:
    """Find a directory containing the lgtv package and add it to sys.path."""
    start = Path(anchor or __file__).resolve()
    here = start.parent if start.is_file() else start
    candidates = _search_roots(here)

    for root in candidates:
        if _has_lgtv_package(root):
            _prepend_sys_path(root)
            return root

    searched = "\n".join(f"  - {p}" for p in candidates)
    raise ImportError(f"lgtv package not found. Searched:\n{searched}")
