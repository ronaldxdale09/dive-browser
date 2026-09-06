# Security Policy

Dive renders untrusted web content in Chromium, exposes browser control to
local AI agents over HTTP, and runs an agent loop whose instructions come from
pages it visits. We take reports against any of that seriously.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a
security problem.**

Report privately through GitHub: open the repository's **Security** tab and
choose [**Report a vulnerability**](https://github.com/ronaldxdale09/dive-browser/security/advisories/new)
to start a private advisory.

### What to include

- What an attacker gains, and what they need to start (a visited page? a
  process on the same machine? an MCP client the person already trusts?)
- Affected version — `Dive → About`, or the `version` in `Cargo.toml`
- Steps to reproduce, ideally a minimal page or script
- macOS version and chip (Apple Silicon or Intel)

### What to expect

- Acknowledgement within 5 working days
- An assessment, with severity and a fix plan, within 10 working days
- Credit in the release notes when a fix ships, unless you ask otherwise

## Supported versions

Dive is pre-1.0 and ships from `main`. Only the latest release gets fixes;
there are no maintenance branches yet.

## Areas we especially want reports on

These are the parts where a bug is a security bug rather than a defect:

- **MCP server** (`crates/dive-mcp`). It binds loopback and requires a bearer
  token, rejects browser `Origin` headers, and parses the `Host` header as a
  host rather than a prefix so `localhost.evil.com` cannot reach it. Anything
  that gets past that, or any way to read the token, is in scope.
- **The agent tool loop** (`apps/desktop/src-tauri/src/agent_tools.rs`). The
  agent reads page content, and page content is attacker-controlled. A page
  that steers the agent into acting outside the tab the person is in — reaching
  internal network addresses, exfiltrating another origin's data, or escalating
  a read tool into a write — is in scope.
- **Request interception and workspace rules** (`privacy.rs`, `rules.rs`). A
  rule that leaks across workspace boundaries, or a mock/rewrite that applies
  to an origin it was not scoped to, breaks the isolation `CefRequestContext`
  is there to provide.
- **Secrets at rest.** Provider API keys live in the OS keychain. Any path that
  reads them out of the renderer, logs them, or writes them to disk is in scope.
- **The updater.** Anything that weakens signature verification, or installs an
  artifact the maintainer did not sign.

## Out of scope

- Vulnerabilities in Chromium itself. Report those to the
  [Chromium project](https://issues.chromium.org/); we pick up fixes when we
  bump CEF. Tell us anyway if our CEF pin is what leaves users exposed.
- Ad and tracker filter lists missing a domain. That is a filter-list gap, so
  file it as an ordinary issue.
- Findings that need the attacker to already run code as the user, or to have
  physical access to an unlocked machine.
- Reports produced by running a scanner against a build with no analysis of
  whether the finding is reachable.
