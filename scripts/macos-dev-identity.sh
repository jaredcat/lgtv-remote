#!/bin/bash
# Ensure the stable macOS code-signing identity is in the login keychain.
# The certificate lives in 1Password. Generating a new one would make macOS
# treat the app as a different program, and Local Network permission would not carry over.

set -euo pipefail

IDENTITY="lgtv-tray-remote-dev"
ACCOUNT="${LGTV_OP_ACCOUNT:-my.1password.com}"
VAULT="${LGTV_OP_VAULT:-lgtv-remote}"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
P12_PASSWORD=""

identity_present() {
  security find-identity -p codesigning 2>/dev/null | grep -F "\"$IDENTITY\"" >/dev/null
}

require_op() {
  if ! command -v op >/dev/null 2>&1; then
    echo "1Password CLI (op) is required to import $IDENTITY." >&2
    exit 1
  fi
}

create_material() {
  local dir="$1" conf
  P12_PASSWORD="$(openssl rand -base64 32)"
  printf '%s' "$P12_PASSWORD" >"$dir/password"
  chmod 600 "$dir/password"
  conf="$(mktemp)"
  cat >"$conf" <<EOF
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = codesign_ext

[ dn ]
CN = $IDENTITY
O = lgtv-remote
OU = local

[ codesign_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -new -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$dir/codesign.key" -out "$dir/codesign.crt" -config "$conf" >/dev/null 2>&1
  rm -f "$conf"
  chmod 600 "$dir/codesign.key" "$dir/codesign.crt"
  # macOS security import rejects OpenSSL 3's default PBE. -legacy matches
  # the algorithms the Security framework still accepts.
  openssl pkcs12 -export -legacy \
    -out "$dir/codesign.p12" -inkey "$dir/codesign.key" -in "$dir/codesign.crt" \
    -name "$IDENTITY" -passout "pass:$P12_PASSWORD" >/dev/null
  chmod 600 "$dir/codesign.p12"

  python3 - "$dir/password" "$dir/item.json" <<'PY'
import json, sys
password = open(sys.argv[1]).read()
notes = (
    "Self-signed macOS code signing certificate for LG TV Remote "
    "(com.codekitties.lgtv.remote). Local Network permission is tied to this "
    "certificate. Do not regenerate it. The password field unlocks the p12 attachment."
)
json.dump(
    {
        "title": "lgtv-tray-remote-dev",
        "category": "PASSWORD",
        "tags": ["lgtv-remote", "macos-signing"],
        "fields": [
            {
                "id": "password",
                "type": "CONCEALED",
                "purpose": "PASSWORD",
                "label": "password",
                "value": password,
            },
            {
                "id": "notesPlain",
                "type": "STRING",
                "purpose": "NOTES",
                "label": "notesPlain",
                "value": notes,
            },
        ],
    },
    open(sys.argv[2], "w"),
    indent=2,
)
open(sys.argv[2], "a").write("\n")
PY
  chmod 600 "$dir/item.json"
  op item create \
    --account "$ACCOUNT" \
    --vault "$VAULT" \
    --template "$dir/item.json" \
    "p12[file]=$dir/codesign.p12" \
    >/dev/null
}

fetch_material() {
  local dir="$1"
  op read --account "$ACCOUNT" --out-file "$dir/codesign.p12" \
    "op://${VAULT}/${IDENTITY}/p12" >/dev/null
  chmod 600 "$dir/codesign.p12"
  P12_PASSWORD="$(op read --account "$ACCOUNT" "op://${VAULT}/${IDENTITY}/password")"
  P12_PASSWORD="${P12_PASSWORD%$'\n'}"
  openssl pkcs12 -legacy -in "$dir/codesign.p12" -clcerts -nokeys \
    -passin "pass:$P12_PASSWORD" -out "$dir/codesign.crt"
  chmod 600 "$dir/codesign.crt"
}

import_p12() {
  local dir="$1"
  security import "$dir/codesign.p12" \
    -k "$LOGIN_KEYCHAIN" \
    -P "$P12_PASSWORD" \
    -f pkcs12 \
    -T /usr/bin/codesign \
    -T /usr/bin/security \
    -A >/dev/null
  # Login-keychain trust is enough for local launches. A System keychain
  # trust would need an admin password and is not required here.
  security add-trusted-cert -d -r trustRoot -p codeSign \
    -k "$LOGIN_KEYCHAIN" \
    "$dir/codesign.crt" >/dev/null
}

if identity_present; then
  echo "$IDENTITY"
  exit 0
fi

require_op

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

if ! lookup_err="$(op item get "$IDENTITY" --account "$ACCOUNT" --vault "$VAULT" 2>&1 >/dev/null)"; then
  if [[ "$lookup_err" == *"isn't an item"* ]]; then
    echo "Creating $IDENTITY in 1Password ($VAULT on $ACCOUNT)." >&2
    create_material "$tmp"
  else
    printf '%s\n' "$lookup_err" >&2
    exit 1
  fi
else
  echo "Importing $IDENTITY from 1Password into the login keychain." >&2
  fetch_material "$tmp"
fi

import_p12 "$tmp"

if ! identity_present; then
  echo "Identity $IDENTITY is not trusted for code signing after import." >&2
  echo "In Keychain Access, open $IDENTITY and set Code Signing to Always Trust." >&2
  exit 1
fi

echo "$IDENTITY"
