#!/usr/bin/env bash
# local-release.sh — the release workflow, run on this Mac instead of a
# GitHub-hosted macOS runner.
#
#   scripts/release/local-release.sh [patch|minor|major|rc] [exact-version]
#
# Same path as .github/workflows/release.yml, in the same order: resolve the
# version, run the fast preflight, stamp the version into this checkout, build
# and sign, notarize, write latest.json, publish the GitHub release (which
# creates the tag), verify what GitHub stored, and only then commit the version
# bump to main. A failure before publishing restores the stamped files and
# leaves no tag, release or commit behind.
#
# Needs: a clean, pushed `main`; `gh` logged in; the updater keypair under
# ~/.tauri (dive.key, dive.key.password, dive.key.pub, or point
# TAURI_SIGNING_PRIVATE_KEY_PATH elsewhere); a "Developer ID Application"
# identity in the login keychain; and for notarization either APPLE_ID,
# APPLE_PASSWORD and APPLE_TEAM_ID in the environment (Tauri notarizes during
# the build) or a notarytool keychain profile (DIVE_NOTARY_PROFILE, default
# "dive"; create one with `xcrun notarytool store-credentials dive`).
set -euo pipefail

KIND="${1:-patch}"
VERSION_ARG="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

die() { echo "!! $*" >&2; exit 1; }
step() { echo; echo ">> $*"; }

export CEF_PATH="${CEF_PATH:-$HOME/.local/share/cef}"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/dive.key}"
NOTARY_PROFILE="${DIVE_NOTARY_PROFILE:-dive}"
STAMPED=(Cargo.toml Cargo.lock apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/cef/crash_reporter.cfg)

step "preconditions"
[[ -d "${CEF_PATH}" ]] || die "CEF_PATH ${CEF_PATH} does not exist"
[[ -f "${KEY}" && -f "${KEY}.pub" ]] || die "updater keypair not found at ${KEY} (see RELEASING.md)"
[[ "$(git branch --show-current)" == "main" ]] || die "release from main"
git diff --quiet && git diff --cached --quiet || die "working tree must be clean"
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main; push or pull first"
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
[[ -n "${APPLE_SIGNING_IDENTITY}" ]] || die "no Developer ID Application identity in the keychain; set APPLE_SIGNING_IDENTITY"
export APPLE_SIGNING_IDENTITY
if [[ -z "${APPLE_ID:-}" ]]; then
    xcrun notarytool history --keychain-profile "${NOTARY_PROFILE}" >/dev/null 2>&1 \
        || die "no notarization credentials: set APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or run: xcrun notarytool store-credentials ${NOTARY_PROFILE}"
fi
echo "signing as ${APPLE_SIGNING_IDENTITY}"

step "resolve version"
RESOLVED="$(node scripts/release/resolve-release.mjs --kind "${KIND}" ${VERSION_ARG:+--version "${VERSION_ARG}"})"
field() { node -e 'const r=JSON.parse(process.argv[1]);console.log(r[process.argv[2]])' "${RESOLVED}" "$1"; }
VERSION="$(field version)"; TAG="$(field tag)"; NAME="$(field name)"
IS_PRERELEASE="$(field isPrerelease)"; MAKE_LATEST="$(field makeLatest)"
echo "${NAME} (${TAG}), prerelease=${IS_PRERELEASE}, latest=${MAKE_LATEST}"
COMMIT="$(git rev-parse HEAD)"

step "preflight"
pnpm typecheck
pnpm lint
pnpm test

step "stamp ${VERSION} into this checkout"
PUBLISHED=0
restore() {
    if [[ "${PUBLISHED}" -eq 0 ]]; then
        git checkout -q -- "${STAMPED[@]}" || true
        echo "restored the unstamped files; nothing was published"
    fi
}
trap restore EXIT
node scripts/release/stamp-versions.mjs "${VERSION}"

step "build, sign${APPLE_ID:+, notarize}"
PUBKEY="$(tr -d '\n' < "${KEY}.pub")"
TAURI_SIGNING_PRIVATE_KEY="$(cat "${KEY}")" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "${KEY}.password" 2>/dev/null || true)" \
DIVE_UPDATER_PUBKEY="${PUBKEY}" \
    pnpm --filter @dive/desktop exec tauri build \
        --config "{\"plugins\":{\"updater\":{\"pubkey\":\"${PUBKEY}\"}}}"
scripts/release/prepare-bundle.sh target/release/bundle/macos/Dive.app

step "collect artifacts"
rm -rf out && mkdir -p out
shopt -s nullglob
cp target/release/bundle/dmg/*.dmg out/
cp target/release/bundle/macos/*.tar.gz out/
cp target/release/bundle/macos/*.tar.gz.sig out/
archives=(out/*.tar.gz); signatures=(out/*.tar.gz.sig); images=(out/*.dmg)
[[ "${#archives[@]}" -eq 1 && "${#signatures[@]}" -eq 1 && "${#images[@]}" -eq 1 ]] \
    || die "expected one dmg, one updater archive and one signature; found ${#images[@]}, ${#archives[@]}, ${#signatures[@]}"

if [[ -z "${APPLE_ID:-}" ]]; then
    step "notarize ${images[0]##*/} with keychain profile ${NOTARY_PROFILE}"
    xcrun notarytool submit "${images[0]}" --keychain-profile "${NOTARY_PROFILE}" --wait
    xcrun stapler staple "${images[0]}"
    spctl -a -t open --context context:primary-signature -v "${images[0]}"
fi

step "update manifest"
node scripts/release/update-manifest.mjs build \
    --version "${VERSION}" \
    --target aarch64-apple-darwin \
    --archive "${archives[0]}" \
    --signature-file "${signatures[0]}" \
    --notes "${NAME}" \
    --base-url "https://github.com/${REPO}/releases/download/${TAG}" \
    --out out/manifest-aarch64-apple-darwin.json
node scripts/release/update-manifest.mjs merge out/manifest-*.json \
    --expect-platforms darwin-aarch64 \
    --out out/latest.json
rm -f out/manifest-*.json

step "publish ${TAG} to GitHub Releases"
flags=(--target "${COMMIT}" --title "${NAME}" --generate-notes)
[[ "${IS_PRERELEASE}" == "true" ]] && flags+=(--prerelease)
[[ "${MAKE_LATEST}" == "true" ]] && flags+=(--latest) || flags+=(--latest=false)
gh release create "${TAG}" "${flags[@]}" out/latest.json "${images[0]}" "${archives[0]}" "${signatures[0]}"
PUBLISHED=1

step "verify what GitHub stored"
GITHUB_REPOSITORY="${REPO}" GITHUB_TOKEN="$(gh auth token)" \
    node scripts/release/verify-release-assets.mjs "${TAG}"

step "record ${VERSION} on main"
git add "${STAMPED[@]}"
git commit -q -m "chore(release): ${TAG}"
git push origin HEAD:main

echo
echo "${NAME} released: https://github.com/${REPO}/releases/tag/${TAG}"
