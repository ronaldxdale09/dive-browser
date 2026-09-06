#!/usr/bin/env bash
# One command to load the Apple signing + notarization secrets into GitHub.
# Secrets go straight from your machine to your repo via the gh CLI; they only
# come from you: a password to protect the exported key, your Apple ID, and an
# app-specific password from https://account.apple.com. Runs from any folder.
set -euo pipefail

REPO="ronaldxdale09/dive-browser"
IDENTITY="Developer ID Application: RONALD DALE FUENTEBELLA (F67DX3M6QJ)"
P12="$HOME/Desktop/dive-signing.p12"

command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }
security find-identity -v -p codesigning | grep -q "$IDENTITY" \
  || { echo "signing identity not in keychain: $IDENTITY"; exit 1; }

if [ ! -f "$P12" ]; then
  read -rsp "Choose a password to protect the exported certificate: " P12PASS; echo
  security export -t identities -f pkcs12 -k "$HOME/Library/Keychains/login.keychain-db" \
    -o "$P12" -P "$P12PASS" "$IDENTITY"
  echo "Exported $P12"
else
  echo "Using the certificate already exported at $P12"
  read -rsp "Enter the password you set on that .p12: " P12PASS; echo
fi

base64 -i "$P12" | gh secret set APPLE_CERTIFICATE -R "$REPO"
printf '%s' "$P12PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
echo "Set APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD."

read -rp "Your Apple ID email: " APPLEID
printf '%s' "$APPLEID" | gh secret set APPLE_ID -R "$REPO"
read -rsp "App-specific password (from account.apple.com): " APPPW; echo
printf '%s' "$APPPW" | gh secret set APPLE_PASSWORD -R "$REPO"
echo "Set APPLE_ID and APPLE_PASSWORD."

rm -f "$P12"
echo "Cleaned up $P12."
echo
echo "Apple secrets now on $REPO:"
gh secret list -R "$REPO" | grep -E 'APPLE_' || true
echo "Done. Run the release workflow when ready."
