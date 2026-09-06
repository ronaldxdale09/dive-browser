# Browser Essentials and Chromium Extensions Design

**Date:** 2026-09-04

## Objective

Make Dive's browser essentials trustworthy across persistent containers, then add a native extension manager that loads compatible unpacked Chromium extensions without sacrificing Dive's existing chrome, tabs, profiles, or privacy model.

“Compatible with any Chrome extension” is interpreted as broad Chromium Manifest V2/V3 compatibility provided by the pinned CEF Chrome runtime. Dive will not claim universal compatibility: extensions that depend on Google-only services, Chrome Web Store installation APIs, unsupported Chromium APIs, or Chrome-owned toolbar surfaces may not work. The manager will make that boundary visible instead of silently pretending an extension is active.

## Existing Problems

- The CEF permission handler currently accepts camera and microphone requests without invoking Tauri's application permission callback, bypassing remembered allow/deny decisions.
- Browsing-data clearing operates only through open DevTools sessions, limits site-data removal to current tab origins, ignores protocol failures, and can report success without clearing closed profiles.
- Startup always uses Chromium's testing-only mock keychain switch.
- Startup always disables extensions, and Dive has no durable extension registry, validation, management UI, or compatibility status.

## Architecture

### CEF Runtime Integration

Apply remembered decisions through Chromium's `Browser.setPermission` policy for every active page and install a document-start media guard that consults Dive's existing per-origin permission policy before calling the native media API. This works around the pinned CEF adapter's unconditional media acceptance without importing or forking framework internals.

Camera and microphone are evaluated independently. Allowed capabilities are applied to Chromium before the native request; denied or undecided capabilities reject before native capture begins. Unknown capabilities default to denial.

This preserves the existing `PermissionAsked` event and remembered origin decisions rather than creating a second permission system.

### Cookie, Cache, and Site Data

The clear-data command will operate once per browser container rather than once per tab:

- open containers are cleared through their CEF request context;
- closed persistent containers are cleared safely from their dedicated profile directories;
- cookie, HTTP cache, and site-data selections remain independent;
- failures are returned to the UI and are never summarized as success;
- path validation guarantees deletion stays beneath Dive's profiles root.

Session cookies will be verified across a controlled restart. Persistent containers will retain session cookies as configured by CEF; private containers remain memory-only.

The unconditional mock-keychain switch will be removed. An explicit development-only environment override may retain it for isolated tests, while normal and release launches use the operating system's credential protection.

### Extension Registry and Loading

Dive will maintain a versioned JSON registry beneath its application data directory. Each record contains a stable ID, canonical source directory, parsed manifest metadata, enabled state, compatibility warnings, and last validation error.

The backend will:

1. import an unpacked extension directory selected through a native directory picker;
2. canonicalize the path and reject missing, malformed, or oversized manifests;
3. accept Manifest V2 or V3 and validate required names, versions, entry points, and path containment;
4. display requested permissions and compatibility warnings before the extension is considered usable;
5. persist enable/disable/remove changes atomically;
6. build a deterministic, comma-separated `--load-extension` startup argument from enabled valid entries;
7. require a browser restart after changes because CEF supports extension loading at process startup;
8. never execute or copy extension code into Dive's privileged React chrome.

Chrome Web Store download/install automation is out of scope because it relies on Chrome-owned services and policy. Users may load unpacked extensions obtained from sources they trust.

### Native UI

Add a puzzle-piece button in the toolbar beside the page-action group shown in the supplied screenshot. It opens a lazy-loaded `Extensions` dialog/page consistent with Library and Settings.

The page includes:

- installed extension cards with icon, name, version, Manifest generation, status, and warnings;
- enable/disable switches;
- removal with confirmation;
- `Load unpacked` using the native directory picker;
- requested-permission disclosure;
- a restart-required banner and restart action;
- an empty state explaining supported installation and compatibility limits.

The compact toolbar places the same action in its overflow tray. Keyboard focus, Escape dismissal, labels, and reduced-motion behavior follow existing dialog conventions.

## Error Handling and Security

- Fail closed for unknown permissions and malformed extension metadata.
- Canonicalize every filesystem path; manifest-relative resources may not escape the extension root.
- Cap manifest and icon sizes and accept only local directories.
- Write registry updates via temporary file plus rename.
- Avoid extension access to Dive IPC: extensions run only in CEF page contexts, while Tauri capability checks continue to protect the chrome.
- Surface restart and load failures explicitly.

## Verification

- Unit tests for CEF permission mapping, mixed media requests, and fail-closed behavior.
- Rust tests for manifest parsing, traversal rejection, registry round trips, startup arguments, and safe profile targeting.
- React tests for toolbar placement, compact overflow, loading/empty/error states, toggles, removal, permission disclosure, and restart state.
- Existing full `pnpm check` gate.
- Exact-binary live checks for camera allow/deny/ask, microphone, persistent/session cookies, local/session storage, IndexedDB, Cache Storage, cache clearing, profile isolation, and extension content-script execution across restart.
- Recheck the final binary fingerprint so live evidence matches the tested build.
