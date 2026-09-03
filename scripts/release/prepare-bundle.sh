#!/usr/bin/env bash
# Finish a macOS bundle after `tauri build`: drop the crashpad config into the
# CEF framework and print what a release should carry.
set -euo pipefail
APP="${1:?usage: prepare-bundle.sh path/to/Dive.app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${SCRIPT_DIR}/../../apps/desktop/src-tauri/cef/crash_reporter.cfg"
FRAMEWORK="${APP}/Contents/Frameworks/Chromium Embedded Framework.framework"
[[ -d "${FRAMEWORK}" ]] || { echo "no CEF framework in ${APP}" >&2; exit 1; }
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${SCRIPT_DIR}/../../apps/desktop/src-tauri/tauri.conf.json" | head -1)
sed "s/^ProductVersion=.*/ProductVersion=${VERSION}/" "${CFG}" > "${FRAMEWORK}/Resources/crash_reporter.cfg"
echo "crash_reporter.cfg installed for ${VERSION}"
