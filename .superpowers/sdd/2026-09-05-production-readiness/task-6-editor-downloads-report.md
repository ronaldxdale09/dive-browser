# Native editor downloads and visible workflow verification

2026-09-05, isolated worktree dale/production-readiness.

## Reproduced problem and fix

Native capture exports created valid files but Downloads said nothing had downloaded. Page views had a destination/notice callback; the main and popout chrome views hosting capture/recording/tools did not. Main and popout chrome now share the same callback with page views, so editor exports honor the configured folder, retain duplicate filename handling, and emit started/finished/failed notices. Failure to create the configured directory denies the download. Page activity protection remains attached only to its originating native page.

## Validation

- Seven engine tests pass, including configured directory creation, preservation of an existing file, duplicate naming, and rejecting a destination beneath a file. Strict workspace Clippy and source review pass.
- Before binary 3fedd4496a95c2c6f1431b81996e8b9599a5782cb34fe724e2e99ba11371c9d7: CUA confirmed PNG/JPEG/PDF export files, but empty Downloads UI. Log target/workflows-ui-native.log.
- After binary 7d78efac3be32ecdb87febc4f62cf7d502b6c03231d1a1046bbb9a2d0a8a41bd: CUA confirmed all three formats show Saved and individual reveal controls. Each duplicate received (1), preserving the earlier file. Settings Downloads was changed within the disposable profile to /tmp/dive-export-ui-qualification; another PNG was saved there and listed as Saved. Native files identify as 1072x736 PNG/JPEG and a one-page PDF. Log target/export-ui-native.log.
- Both UI sessions exited naturally and drained helpers (287.35s and 105.51s total interactive duration, not shutdown timings). All launches used disposable profiles, mock Chromium and agent keychains, and volatile AppKit ignore-state arguments. No keychain prompt appeared.

## Additional visible workflow evidence

The before session successfully navigated example.com; Find reported 1/2 and Return advanced to 2/2. Capture opened its result tab with an accurately rendered preview. Console displayed the site's actual favicon404; Network captured document200 and timing; Storage displayed its empty cookie/local/session state. A11y audit completed with two landmark violations and13 passes for the external page. Vitals after reload reported FCP/LCP140ms, TTFB126ms, DCL/Load134ms and CLS0.000. These are one-page observations, not universal performance guarantees.

## Open limits

Drag and text placement on the capture canvas did not register via CUA while accessible toolbar buttons did. No native pointer-event diagnosis yet; do not claim annotation qualification or infer a confirmed product cause. Popout export uses the same handler but was not exercised through a separate popout UI. Download cancellation, interrupted/restarted persistence, large-page capture, compact layout, every developer/media/agent feature and signed release qualification remain open. Native permission WebUI diagnostic still has a separate opt-in crash. This does not close the full production-readiness goal.

## Additional native feature pass

The same7d78efac binary, target/features-ui-native.log, passed bookmark creation and library listing, iPhone14Pro portrait/landscape rendering and exit back to ordinary viewport, two-tab search/selection, creation of a separate-cookie workspace and Cmd+1 restoration of the prior workspace/tabs. Pointer clicking the page's Learn more link navigated to the IANA page and rendered it. Capturing that longer page produced a2114x1770 preview. Canvas text placement still did not register, even after both native page tabs were closed; this rules out those hidden sibling views as the immediate explanation in this test. No annotation fix or pass is claimed. Normal Quit/helper drain passed. The shared Downloads fix has native export evidence, while these broader feature checks remain representative rather than exhaustive.
