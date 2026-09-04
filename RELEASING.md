# Releasing Dive

Dive uses an automated, deterministic release pipeline modeled after production desktop browser standards (Orca).

A release is orchestrated through `.github/workflows/release-cut.yml` with semantic floor validation, multi-manifest synchronization, draft release staging, preflight quality gates, artifact completeness verification, and atomic publishing for in-app updaters.

## Automated Release Pipeline (`release-cut.yml`)

The primary entry point to cut a release is the GitHub Actions workflow **`release-cut`**:

1. Go to **Actions** -> **release-cut** -> **Run workflow**.
2. Choose:
   - **Release kind**: `rc` (default), `patch`, `minor`, `major`.
   - **Ref**: branch, tag, or SHA (defaults to `main`).
   - **Dry run**: check version calculation without tagging or releasing.
   - **Version suffix**: optional identifier (e.g. `beta`, `nightly`).
   - **Version**: explicit override (must be strictly greater than latest stable).
3. The workflow runs through:
   - **Semantic Floor Protection**: Prevents regressions by ensuring candidate versions are strictly greater than the latest published stable tag (`latest-stable-release.mjs`).
   - **Multi-Manifest Atomic Bump**: Synchronizes `Cargo.toml`, `apps/desktop/package.json`, and `apps/desktop/src-tauri/tauri.conf.json` (`bump-version.mjs`).
   - **Tag & Push**: Creates an annotated `vX.Y.Z` or `vX.Y.Z-rc.N` tag, pushes to origin, and fast-forwards `main` if releasing from `main`.
   - **Draft Release Staging**: Creates a draft release on GitHub with bounded, automatically generated release notes (`create-draft-release.mjs`).
   - **Preflight Quality Gates**: Runs full formatting, clippy, cargo tests, Vitest tests, TypeScript compilation, and Vite builds.
   - **Build & Notarize**: Builds signed, notarized macOS application bundles, updater `.tar.gz`, `.tar.gz.sig`, and `latest.json`.
   - **Artifact Completeness Gate**: Validates that all required binaries and updater metadata exist, are non-empty, and signatures match (`verify-release-required-assets.mjs`).
   - **Atomic Publishing**: Flips draft to published (`draft: false`, `prerelease: true/false`).

## Local Release Verification & Tools

To inspect what version will be cut or test locally:

```bash
# Check next version based on local tags or GitHub releases
pnpm release:check rc
pnpm release:check patch
pnpm release:check minor
pnpm release:check major

# Bump local manifests atomically
node scripts/release/bump-version.mjs 0.2.0
```

## Secrets the Release Workflow Needs

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application certificate, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | its password |
| `KEYCHAIN_PASSWORD` | any string; protects the temporary CI keychain |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization account (app-specific password) |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater signing key from `tauri signer generate` |
| `TAURI_SIGNING_PUBLIC_KEY` | the matching public key, compiled in as `DIVE_UPDATER_PUBKEY` |

Generate the updater key once with `pnpm --filter @dive/desktop exec tauri signer generate -w ~/.tauri/dive.key` and keep the private half out of the repository. A build without `DIVE_UPDATER_PUBKEY` has no updater at all; that is what development and local builds produce.

## In-App Push Updates

Dive Browser checks for updates 10 seconds after launch (avoiding startup contention) and can also be checked manually from **Settings -> Updates** or **Help -> Check for updates**.

When an update is published:
1. The app queries `https://github.com/ronaldxdale09/dive-browser/releases/latest/download/latest.json`.
2. The Tauri updater validates the cryptographic signature with the public key.
3. An **Update available** chip appears in the feature bar.
4. Clicking **Install and restart** applies the update atomically and relaunches Dive.

## Crash and log locations

- Browser-process panics: `<data dir>/crashes/panic-<timestamp>.txt`
- Renderer minidumps (crashpad): `<data dir>/profiles/Crashpad/` — local only until a release sets `ServerURL` in `apps/desktop/src-tauri/cef/crash_reporter.cfg`.
- Logs: `<data dir>/logs/dive.<date>.log`, rotated daily, seven kept.
- Database backups: `<data dir>/dive.db.before-v<N>` written once before a schema migration to version N.

The data directory is `~/Library/Application Support/app.dive.browser` unless `DIVE_DATA_DIR` says otherwise.
