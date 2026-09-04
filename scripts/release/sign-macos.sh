#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

APP_PATH="${1:-${REPO_ROOT}/target/live-exact/Dive.app}"
ENTITLEMENTS="${REPO_ROOT}/apps/desktop/src-tauri/entitlements.plist"

# Detect Developer ID Application identity if not provided
if [ -z "${2:-}" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application:" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  if [ -z "$IDENTITY" ]; then
    echo "❌ Error: No 'Developer ID Application' identity found in macOS Keychain." >&2
    echo "   Please install your Apple Developer certificate or provide an identity argument." >&2
    exit 1
  fi
else
  IDENTITY="$2"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "❌ Error: App bundle not found at $APP_PATH" >&2
  exit 1
fi

echo "======================================================"
echo " Dive Browser macOS Signing & Verification Pipeline"
echo "======================================================"
echo "Target App:    $APP_PATH"
echo "Identity:      $IDENTITY"
echo "Entitlements:  $ENTITLEMENTS"
echo "Timestamp:     Apple Secure Timestamp Server"
echo "Runtime:       Hardened Runtime (--options runtime)"
echo "------------------------------------------------------"

# 1. Sign dylibs inside Chromium Embedded Framework
echo "--> [1/5] Signing CEF dynamic libraries..."
find "$APP_PATH/Contents/Frameworks/Chromium Embedded Framework.framework" -name "*.dylib" | while read -r dylib; do
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$dylib"
done

# 2. Sign Chromium Embedded Framework itself
echo "--> [2/5] Signing Chromium Embedded Framework..."
codesign --force --sign "$IDENTITY" --timestamp --options runtime "$APP_PATH/Contents/Frameworks/Chromium Embedded Framework.framework"

# 3. Sign Helper apps
echo "--> [3/5] Signing helper processes..."
find "$APP_PATH/Contents/Frameworks" -name "*.app" -depth 1 | while read -r helper; do
  codesign --force --sign "$IDENTITY" --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$helper"
done

# 4. Sign the main executable and app bundle
echo "--> [4/5] Signing main executable and app bundle..."
codesign --force --sign "$IDENTITY" --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$APP_PATH/Contents/MacOS/dive-desktop"
codesign --force --sign "$IDENTITY" --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$APP_PATH"

# 5. Sign any DMG files found in target/release/bundle/dmg/
echo "--> [5/5] Signing DMG installers..."
if [ -d "${REPO_ROOT}/target/release/bundle/dmg" ]; then
  find "${REPO_ROOT}/target/release/bundle/dmg" -name "*.dmg" | while read -r dmg; do
    echo "    Signing DMG: $(basename "$dmg")"
    codesign --force --sign "$IDENTITY" --timestamp "$dmg"
  done
fi

echo "------------------------------------------------------"
echo "==> Signature Verification:"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
echo "✅ Codesign verification passed!"

echo "------------------------------------------------------"
echo "==> Gatekeeper Assessment:"
spctl --assess --type exec -vvv "$APP_PATH" 2>&1 || true

echo "======================================================"
