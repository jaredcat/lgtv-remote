#!/usr/bin/env bash
# Sync version from a single source to tauri.conf.json, Cargo.toml, and flake.nix.
# Usage:
#   ./sync-version.sh              # use version from src-tauri/Cargo.toml
#   ./sync-version.sh 1.0.4         # set version to 1.0.4 everywhere
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -n "$1" ]; then
  VERSION="$1"
  # Strip leading 'v' if present
  VERSION="${VERSION#v}"
else
  # Read from Cargo.toml
  VERSION=$(grep '^version = ' src-tauri/Cargo.toml | sed 's/version = "\(.*\)"/\1/')
fi

echo "Setting version to $VERSION"

# Update Cargo.toml
sed -i.bak "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak

# Update tauri.conf.json
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
rm -f src-tauri/tauri.conf.json.bak

# Update flake.nix (version in packages.default)
sed -i.bak "s/version = \"[^\"]*\";/version = \"$VERSION\";/" flake.nix
rm -f flake.nix.bak

echo "Done. Version $VERSION is now set in Cargo.toml, tauri.conf.json, and flake.nix."
