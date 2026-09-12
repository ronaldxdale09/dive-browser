# Releasing Dive

One channel, one path. A release is proven before the repository records it:
the version is resolved in CI, the tag is created by the publish step, and the
version bump is committed to `main` only after the release exists and has been
verified.

A run that fails leaves nothing behind — no tag, no commit, no half-release.

---

## Cutting a release

### From GitHub (the normal way)

**Actions → `release` → Run workflow**, pick a bump, run it.

| Bump | From `v0.1.4` | Notes |
|---|---|---|
| `patch` | `0.1.5` | Promotes an outstanding candidate to its own stable version rather than skipping past it. |
| `minor` | `0.2.0` | |
| `major` | `1.0.0` | |
| `rc` | `0.1.5-rc.0` | Published as a prerelease and **not** made `latest`, so it never becomes the version the updater serves. |

You can also give an exact version (`0.2.0`) in the *version* field, which
overrides the bump.

### From this machine

```bash
gh workflow run release.yml --ref main -f kind=patch -f windows_only=true
# Read the new run ID from gh run list --workflow release.yml, then:
DIVE_WINDOWS_RUN=<run-id> scripts/release/local-release.sh patch
```

The same path as the workflow, run locally: resolve, preflight, stamp, build
and sign, notarize, `latest.json`, publish (creating the tag), verify, then
commit the bump to `main`.

Windows is built by the `release` workflow using `windows_only=true`, which
skips the hosted macOS build and publishing; point `DIVE_WINDOWS_RUN` at the run that built
`windows-x86_64` and its installer joins the release. `DIVE_SKIP_WINDOWS=1`
cuts a macOS-only release instead: the manifest then carries one platform, so
a Windows install is offered nothing rather than something broken, but the
release page has no installer for it either. A failure before publishing restores the stamped
files. It needs the updater keypair in `~/.tauri` (`dive.key`,
`dive.key.password`, `dive.key.pub`), a Developer ID identity in the login
keychain, and notarization credentials: `APPLE_ID`, `APPLE_PASSWORD` and
`APPLE_TEAM_ID` in the environment, or a notarytool keychain profile named
`dive` (`xcrun notarytool store-credentials dive`). Use it when GitHub-hosted
macOS minutes are not available. The local script waits for that Windows run,
checks its source commit matches, and verifies the signed macOS bundle with
the native live harness before publishing.

### From a tag

```bash
git tag v0.1.5
git push origin v0.1.5
```

The version is read from the tag. Everything after that is identical.

### Preview the next version

```bash
pnpm release:next --kind patch
```

Read-only. It touches nothing.

---

## What the workflow does

```
preflight   Resolve the version from the tag or the bump. Refuse a version
            that was already published. Run typecheck, lint and tests.
                    │
build       Stamp the version into this checkout only, build, sign and
            notarize, then write a per-platform update manifest fragment.
            Fails if the updater archive or its signature is missing.
                    │
release     Merge the fragments into one latest.json, publish the release
            (creating the tag), then verify the release GitHub actually
            stored carries every asset an update needs.
                    │
finalize    Commit `chore(release): vX.Y.Z` to main.
```

The heavy Rust gate (`clippy -D warnings`, `cargo test`, `cargo deny`) runs in
`ci.yml` on every push to `main`, so `preflight` runs the fast half rather than
compiling CEF twice.

---

## Required secrets

The build **fails** without the updater keypair. An app built without it cannot
verify an update, and produces no signature to publish — shipping that is the
failure this pipeline exists to prevent.

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs the updater archive. Required. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password. Required. |
| `TAURI_SIGNING_PUBLIC_KEY` | Baked into the app so it can verify updates. Required. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | Developer ID signing. Optional; without it the build is not notarized. |
| `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization. Optional. |
| `RELEASE_TOKEN` | Only needed if `main` is protected against the default `GITHUB_TOKEN`. |

`scripts/release/setup-signing-secrets.sh` loads the Apple ones through the
`gh` CLI. It reads the identity from `APPLE_SIGNING_IDENTITY`, the repository
from the checkout it runs in, and exports the certificate to the path given as
its argument (or `DIVE_SIGNING_P12`; default `./dive-signing.p12`, deleted after
upload):

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/release/setup-signing-secrets.sh
```

### The updater public key

`plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json` is
deliberately empty in the repository. JSON cannot carry a comment saying so, so
this is the note: the `build` job injects `TAURI_SIGNING_PUBLIC_KEY` through
`tauri build --config '{"plugins":{"updater":{"pubkey":…}}}'`, and refuses to
build without it. A local `tauri build` therefore produces an app that cannot
verify updates, which is why local builds go through
`tauri.no-updater.conf.json` (below).

### Local builds

`pnpm --filter @dive/desktop build` runs `tauri build --config
src-tauri/tauri.no-updater.conf.json`, an overlay that sets
`bundle.createUpdaterArtifacts: false`. It exists so a developer can produce a
`.app` without the updater keypair; nothing built that way is publishable, and
the release workflow never uses it.

---

## The scripts

Each is plain Node with tests in `scripts/release/release.test.mjs`, so the
decisions can be exercised without cutting a release.

| Script | Does |
|---|---|
| `resolve-release.mjs` | Version from a tag or a bump; refuses a duplicate; decides prerelease and `make_latest`. |
| `stamp-versions.mjs` | Writes the version into `Cargo.toml`, `Cargo.lock` (workspace crates only), `apps/desktop/package.json`, `tauri.conf.json` and the crashpad `crash_reporter.cfg`. Textual, so `finalize` needs no cargo. |
| `update-manifest.mjs` | Builds and merges `latest.json`. Every field is required; a missing signature is an error, not an empty string. |
| `verify-release-assets.mjs` | Checks the published release carries `latest.json`, the `.dmg`, the `.tar.gz` and its `.sig`, none of them empty. |
| `prepare-bundle.sh` | Copies `crash_reporter.cfg` into the CEF framework of a built `.app`, with `ProductVersion` set to the bundled version. |
| `setup-signing-secrets.sh` | Exports the Developer ID certificate and uploads the Apple secrets with `gh`. |
| `local-release.sh` | The whole release path on a local Mac, publishing with `gh`. |

---

## Adding a second architecture

Dive currently ships `darwin-aarch64` only. To add Intel:

1. Add a matrix to the `build` job with `aarch64-apple-darwin` and
   `x86_64-apple-darwin`, building each with `--target <triple>` on a runner of
   that architecture, and pass the triple to `update-manifest.mjs build`.
2. Add `darwin-x86_64` to `--expect-platforms` in the merge step.

The manifest merge already handles multiple platforms and is tested for it;
nothing in the publish step changes.
