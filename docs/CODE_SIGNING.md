# Code signing policy

Dive's release binaries are code-signed so that macOS and Windows can verify
they come from this project and have not been altered since they were built.

## What is signed

- **macOS**: the `Dive.app` bundle and the DMG are signed with an Apple
  Developer ID certificate and notarized by Apple. This is live today.
- **Windows**: the NSIS installer (`Dive_<version>_x64-setup.exe`) is being
  set up for Authenticode signing through the
  [SignPath Foundation](https://signpath.org/)'s free code-signing program for
  open-source projects. The certificate's private key is generated and held on
  SignPath's Hardware Security Module and is never exported. Until that
  certificate is issued, the Windows installer is unsigned and SmartScreen
  warns on first run — see the note in [the README](../README.md#install).

Only binaries built by this repository's release workflow from this
repository's source are signed. Dive signs nothing on a user's behalf and
signs no third-party software.

## How a signed release is produced

1. A maintainer pushes a release tag. The
   [`release` workflow](../.github/workflows/release.yml) builds the macOS and
   Windows artifacts on GitHub-hosted runners directly from the tagged commit.
2. The Windows installer is submitted to SignPath, which verifies that the
   artifact originates from this repository's workflow run before it will sign.
3. A designated approver reviews and approves each signing request. Signing is
   never fully automatic: every signed build is approved by a human.
4. The signed installer is attached to the GitHub release. Its release page is
   the only official source of Dive downloads.

## Who can authorize a signed build

- **Authors** — may push code and release tags. Trusted to change what gets
  built.
- **Reviewers** — review pull requests from outside the trusted set before they
  can reach a release.
- **Approvers** — approve each SignPath signing request. Only an approver can
  cause a build to be signed.

Everyone in these roles authenticates to GitHub and SignPath with multi-factor
authentication enabled.

## Verifying a download

- **macOS**: Gatekeeper verifies the Apple signature and notarization on first
  launch. To check manually: `codesign -dv --verbose=4 /Applications/Dive.app`
  and `spctl -a -vvv /Applications/Dive.app`.
- **Windows** (once signing is live): right-click the installer › **Properties**
  › **Digital Signatures**, or run
  `Get-AuthenticodeSignature .\Dive_<version>_x64-setup.exe`. The signature
  names the SignPath Foundation certificate issued to this project.

## Reporting a problem

If a Dive download fails verification or is signed by an unexpected
certificate, do not run it. Report it through the process in
[SECURITY.md](../SECURITY.md).
