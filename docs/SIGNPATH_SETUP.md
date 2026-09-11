# SignPath signing setup (for maintainers)

Dive applied to the [SignPath Foundation](https://signpath.org/) free
code-signing program on 2026-09-11. This is the checklist to finish wiring
Windows signing once the application is approved. Nothing here is needed by
users; it documents the maintainer steps so the certificate plugs straight in.

## While the application is under review

- Keep the project MIT-licensed with no proprietary components (unchanged).
- Keep the [download page](../README.md#install) mentioning that Dive uses the
  SignPath Foundation for code signing — this is a program requirement and is
  already in place.
- Enable multi-factor authentication on the GitHub and SignPath accounts of
  everyone who can push tags or approve signing.

## Once approved

SignPath provisions an organization, a project, a signing policy and an
HSM-backed certificate. From the SignPath project, collect:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG` (e.g. `dive`)
- `SIGNPATH_SIGNING_POLICY_SLUG` (e.g. `release-signing`)
- `SIGNPATH_API_TOKEN` — a user API token with permission to submit signing
  requests

Add them as GitHub Actions secrets (repo → Settings → Secrets → Actions).

## Wiring the release workflow

The Windows job in [`.github/workflows/release.yml`](../.github/workflows/release.yml)
currently builds the NSIS installer and, in the same step, has Tauri produce
the updater (minisign) signature `*-setup.exe.sig`. SignPath signs the
installer **after** the build, which changes the installer's bytes — so the
order matters:

1. Build the NSIS installer as today. **Discard** the `*-setup.exe.sig` it
   produces: it was computed over the unsigned installer and is about to become
   stale.
2. Upload the unsigned installer with `actions/upload-artifact` and capture the
   step's `outputs.artifact-id`.
3. Submit it with
   [`SignPath/github-action-submit-signing-request`](https://github.com/SignPath/github-action-submit-signing-request),
   passing `organization-id`, `project-slug`, `signing-policy-slug`,
   `github-artifact-id`, `api-token`, `wait-for-completion: true` and an
   `output-artifact-directory`. Download the **signed** installer back over the
   unsigned one.
4. **Re-generate the updater signature over the signed installer** with
   `pnpm --filter @dive/desktop exec tauri signer sign <signed-setup.exe>`
   (needs `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`, already secrets). This
   is the critical step: skip it and the auto-updater will reject the signed
   installer because its minisign signature no longer matches.
5. Run `update-manifest.mjs` and attach the release assets exactly as now — but
   over the signed installer and its fresh `.sig`.

Gate every SignPath step on the token being present (mirror the Apple-cert
step, which no-ops when unconfigured) so that a build without the secrets keeps
producing today's unsigned output instead of failing.

## After the first signed release

- Update [docs/CODE_SIGNING.md](CODE_SIGNING.md) and the README to say Windows
  signing is live, and drop the SmartScreen "Run anyway" note.
- Verify on Windows: `Get-AuthenticodeSignature .\Dive_<version>_x64-setup.exe`
  names the SignPath Foundation certificate, and SmartScreen no longer warns.
