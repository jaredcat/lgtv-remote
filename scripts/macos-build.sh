#!/bin/bash
# Production build signed with the stable local identity.
# Plain `cargo tauri build` leaves the bundle linker-signed, so macOS
# treats every rebuild as a different app.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export APPLE_SIGNING_IDENTITY="$("$ROOT/scripts/macos-dev-identity.sh")"

cd "$ROOT"
exec cargo tauri build "$@"
