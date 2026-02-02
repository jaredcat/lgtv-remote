#!/usr/bin/env bash
# Output a development build version that is consistent across all operating systems.
#
# Format: 0.0.0-<N> where N is 0-65535 derived from the commit SHA.
# - Numeric-only pre-release satisfies Windows MSI (WiX) requirements.
# - Same format on Linux, macOS, Windows, and Nix.
#
# Usage:
#   dev-version.sh [SHA]
# If SHA is omitted, uses GITHUB_SHA (in CI) or git rev-parse HEAD (local).
set -euo pipefail

SHA="${1:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo "0000000")}}"
# First 4 hex chars as decimal (0-65535) for MSI compatibility
NUM_ID=$(printf '%d' "0x${SHA:0:4}")
echo "0.0.0-${NUM_ID}"
