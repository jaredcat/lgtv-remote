#!/usr/bin/env bash
# Build and deploy the plugin to a Steam Deck over SSH.
# Usage: ./deploy.sh [deck@10.0.1.63]

set -euo pipefail

DECK="${1:-deck@10.0.1.63}"
PLUGIN_NAME="lgtv-remote-decky"
REMOTE_PLUGIN_DIR='homebrew/plugins/lgtv-remote-decky'
STAGING="/tmp/${PLUGIN_NAME}-staging"
ZIP_REMOTE="/tmp/${PLUGIN_NAME}.zip"

cd "$(dirname "$0")"

echo "Bundling shared lgtv package..."
rm -rf lgtv
cp -r "$(dirname "$0")/../lgtv" lgtv

echo "Building frontend..."
pnpm run build

echo "Creating ${PLUGIN_NAME}.zip..."
rm -f "${PLUGIN_NAME}.zip"
zip -qr "${PLUGIN_NAME}.zip" \
  dist \
  main.py \
  _lgtv_path.py \
  plugin.json \
  package.json \
  lgtv \
  py_modules \
  README.md

echo "Uploading to Deck..."
scp "${PLUGIN_NAME}.zip" "${DECK}:${ZIP_REMOTE}"

echo "Staging on Deck..."
ssh "${DECK}" "
  set -euo pipefail
  rm -rf '${STAGING}'
  mkdir -p '${STAGING}'
  unzip -qo '${ZIP_REMOTE}' -d '${STAGING}'
  rm -f '${ZIP_REMOTE}'
"

echo "Installing on Deck (sudo password may be required — Decky often leaves root-owned files)..."
# Inline remote command with -tt so sudo can prompt. Decky-owned plugin files need sudo rm/mv.
ssh -tt "${DECK}" '
  set -euo pipefail
  PLUGIN_DIR="$HOME/'"${REMOTE_PLUGIN_DIR}"'"
  if [ -e "$PLUGIN_DIR" ]; then
    sudo rm -rf "$PLUGIN_DIR"
  fi
  sudo mkdir -p "$(dirname "$PLUGIN_DIR")"
  sudo mv "'"${STAGING}"'" "$PLUGIN_DIR"
  sudo chown -R deck:deck "$PLUGIN_DIR"
  echo "Installed to $PLUGIN_DIR"
  ls -la "$PLUGIN_DIR"
'

rm -f "${PLUGIN_NAME}.zip"
echo "Done. Reload plugins in Decky (⋯ → Decky Loader → reload)."
