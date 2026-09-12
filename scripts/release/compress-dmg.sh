#!/usr/bin/env bash
# Recompress a Tauri-built DMG with LZMA, in place, and re-sign it.
#
# Tauri writes the disk image with zlib (UDZO). The same app compressed with
# LZMA (ULMO) is about 30% smaller -- measured 166 MB -> 117 MB -- and nothing
# is removed: it is the identical image, packed harder. macOS 10.15+ mounts
# ULMO; Dive requires 13. It costs build time only (~35 s more to create).
#
# `hdiutil convert` writes a new file, so neither Tauri's code signature on
# the image nor Apple's notarization ticket for it carry over: the ticket is
# keyed to the file's hash. Both are redone here when the credentials are
# configured -- re-signed with the same identity, submitted to the notary
# service, and the ticket stapled so Gatekeeper can verify it offline, which
# Tauri's own DMG does not get. The notarized .app inside is untouched.
#
# usage: compress-dmg.sh path/to/Dive.dmg
#   APPLE_SIGNING_IDENTITY            re-sign the image (optional)
#   APPLE_ID, APPLE_PASSWORD,          notarize and staple it (optional; all
#   APPLE_TEAM_ID                      three or none)
set -euo pipefail
DMG="${1:?usage: compress-dmg.sh path/to/Dive.dmg}"
[[ -f "$DMG" ]] || { echo "no such DMG: $DMG" >&2; exit 1; }

before=$(stat -f%z "$DMG")
tmp="${DMG%.dmg}.ulmo.dmg"
rm -f "$tmp"
hdiutil convert -quiet "$DMG" -format ULMO -o "$tmp"

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$tmp"
  codesign --verify --verbose=2 "$tmp"
else
  echo "APPLE_SIGNING_IDENTITY not set; DMG left unsigned (fine for a local build)"
fi

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "notarizing the recompressed DMG (waits on Apple's queue)..."
  result=$(xcrun notarytool submit "$tmp" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait --output-format json)
  status=$(printf '%s' "$result" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' | head -1)
  if [[ "$status" != "Accepted" ]]; then
    echo "notarization did not return Accepted (got: ${status:-none}):" >&2
    printf '%s\n' "$result" >&2
    exit 1
  fi
  xcrun stapler staple "$tmp"
  spctl -a -t open --context context:primary-signature -v "$tmp" 2>&1 | grep -q 'Notarized Developer ID' \
    || { echo "recompressed DMG is not assessed as notarized" >&2; exit 1; }
elif [[ -n "${APPLE_ID:-}${APPLE_PASSWORD:-}${APPLE_TEAM_ID:-}" ]]; then
  echo "APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID must all be set to notarize" >&2; exit 1
else
  echo "notary credentials not set; DMG not notarized (fine for a local build)"
fi

# Prove the image mounts before it replaces the original.
mount=$(hdiutil attach -nobrowse -readonly -noverify "$tmp" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
[[ -d "$mount" ]] || { echo "converted DMG did not mount" >&2; exit 1; }
ls "$mount" | grep -q '\.app$' || { hdiutil detach "$mount" -quiet; echo "no .app inside the converted DMG" >&2; exit 1; }
hdiutil detach "$mount" -quiet

mv -f "$tmp" "$DMG"
after=$(stat -f%z "$DMG")
printf 'DMG recompressed with LZMA: %d MB -> %d MB (%d%% smaller)\n' \
  $((before/1048576)) $((after/1048576)) $(( (before-after)*100/before ))
