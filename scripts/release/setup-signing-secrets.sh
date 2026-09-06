#!/usr/bin/env bash
# One command to load the Apple signing + notarization secrets into GitHub.
# Secrets go straight from your machine to your repo via the gh CLI; they only
# come from you: a password to protect the exported key, your Apple ID, and an
# app-specific password from https://account.apple.com. Run it from inside the
# repository checkout.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     scripts/release/setup-signing-secrets.sh [path/to/export.p12]
#
# APPLE_SIGNING_IDENTITY  the exact identity string from
#                         `security find-identity -v -p codesigning`. Required.
# P12 path                where to export the certificate (argument, or the
#                         DIVE_SIGNING_P12 env var). Default: ./dive-signing.p12,
#                         which is gitignored. Deleted after upload.
set -euo pipefail

IDENTITY="${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY to your Developer ID Application identity}"
P12="${1:-${DIVE_SIGNING_P12:-$PWD/dive-signing.p12}}"

command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  || { echo "not inside a GitHub repository checkout (gh repo view failed)"; exit 1; }
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
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
echo "Set APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD and APPLE_SIGNING_IDENTITY."

read -rp "Your Apple ID email: " APPLEID
printf '%s' "$APPLEID" | gh secret set APPLE_ID -R "$REPO"
read -rp "Your Apple Team ID (the code in parentheses in the identity): " TEAMID
printf '%s' "$TEAMID" | gh secret set APPLE_TEAM_ID -R "$REPO"
read -rsp "App-specific password (from account.apple.com): " APPPW; echo
printf '%s' "$APPPW" | gh secret set APPLE_PASSWORD -R "$REPO"
echo "Set APPLE_ID, APPLE_TEAM_ID and APPLE_PASSWORD."

rm -f "$P12"
echo "Cleaned up $P12."
echo
echo "Apple secrets now on $REPO:"
gh secret list -R "$REPO" | grep -E 'APPLE_' || true
echo "Done. Run the release workflow when ready."
