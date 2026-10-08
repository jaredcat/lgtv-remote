#!/bin/bash
# Sign an existing .app with the stable local identity.
# Usage: scripts/macos-sign-app.sh "/Applications/LG TV Remote.app"

set -euo pipefail

if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo "Usage: $0 /path/to/App.app" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"
IDENTITY="$("$ROOT/scripts/macos-dev-identity.sh")"

# Finder metadata makes codesign refuse to seal the bundle.
xattr -cr "$APP"

codesign --force --sign "$IDENTITY" --options runtime "$APP"
codesign --verify --strict --verbose=2 "$APP"
echo "Signed $APP as $IDENTITY"
