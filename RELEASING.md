# Releasing Dive

A release is a tag. Everything else is CI. This page lists what a release
needs, the exact commands CI runs so a person can reproduce one, and the
checks that gate it.

## What CI runs on every push

`.github/workflows/ci.yml`, job `check`:

```
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo audit
git diff --exit-code -- apps/desktop/src/generated
pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm --filter @dive/desktop exec vite build
pnpm audit --prod --audit-level=moderate
```

Job `live` builds the debug bundle and drives the real app:

```
pnpm --filter @dive/desktop exec tauri build --debug --bundles app
DIVE_BIN=target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop scripts/live-check.sh
DIVE_BIN=... STRESS_TABS=12 MEM_MIN_RECLAIM_PCT=30 scripts/benchmark-memory.sh
DIVE_BIN=... scripts/benchmark-startup.sh
```

`live-check.sh` opens a tab, reads it, screenshots it, waits for the idle
sweep to discard the background tab and wakes it, kills the renderer helper
and checks the tab recovers while its sibling is untouched, and reads the
in-process CDP benchmark (p95 must stay under 5 ms). Both scripts accept a
`DIVE_BIN` and use a private data directory, so they never touch a running
Dive.

## Secrets the release workflow needs

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application certificate, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | its password |
| `KEYCHAIN_PASSWORD` | any string; protects the temporary CI keychain |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization account (app-specific password) |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater signing key from `tauri signer generate` |
| `TAURI_SIGNING_PUBLIC_KEY` | the matching public key, compiled in as `DIVE_UPDATER_PUBKEY` |

Generate the updater key once with `pnpm --filter @dive/desktop exec tauri
signer generate -w ~/.tauri/dive.key` and keep the private half out of the
repository. A build without `DIVE_UPDATER_PUBKEY` has no updater at all;
that is what development and the `check` job produce.

## Cutting a release

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/package.json` and `Cargo.toml` (`workspace.package`).
2. Make sure `main` is green, including the `live` job.
3. `git tag v0.2.0 && git push origin v0.2.0`.
4. The `release` workflow signs, notarizes, bundles the crashpad config,
   and publishes the `.dmg`, the updater `.tar.gz` + `.sig`, and
   `latest.json`. Installed copies see the update on next launch.

## Crash and log locations

- Browser-process panics: `<data dir>/crashes/panic-<timestamp>.txt`
- Renderer minidumps (crashpad): `<data dir>/profiles/Crashpad/` — local
  only until a release sets `ServerURL` in
  `apps/desktop/src-tauri/cef/crash_reporter.cfg`.
- Logs: `<data dir>/logs/dive.<date>.log`, rotated daily, seven kept.
- Database backups: `<data dir>/dive.db.before-v<N>` written once before a
  schema migration to version N.

The data directory is `~/Library/Application Support/app.dive.browser` unless
`DIVE_DATA_DIR` says otherwise.
