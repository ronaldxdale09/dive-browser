# Workspace counts retain discarded tabs

During computer-use verification, Page A remained in the tab strip with its sleeping indicator while Page B was active, but the Home badge showed 1 tab. Store::tab_counts excluded state=discarded even though renderer discard preserves the open tab and its restoration URL. This also affected profile totals and counts used by workspace deletion confirmation.

The query now counts all workspace-owned tabs, whether Active, Sleeping or Discarded. Global essentials remain excluded because they have no workspace owner. API/store documentation and generated bindings describe open tabs. No lifecycle policy or persistence schema changed.

The replacement regression failed against the original query (2 instead of 3), then passed after removing the predicate. It covers every renderer state, a separate workspace containing only a discarded tab, actual close/decrement/removal and exclusion of a global essential. All 29 core tests and bindings export pass; strict workspace Clippy and source review pass. Logs /tmp/dive-tab-count-red.log, /tmp/dive-tab-count-green.log, /tmp/dive-tab-count-bindings.log and /tmp/dive-tab-count-clippy.log.

Native UI evidence is appended after the exact rebuilt-bundle retest. The separately observed narrow inactive tab title remains a layout-investigation candidate; no width change was made.


Exact native bundle SHA25614b0e04336df96310491cca3b2a357eafdfb19145b0956ad5565f0ec9a5b8460 used a disposable mock profile and explicit per-launch AppKit state override. CUA observed Alpha plus an externally initiated YouTube tab, after Alpha's native discard, with Home correctly reporting2tabs. The planned open/Beta/close/reopen flow did not finish: new-tab attempts were followed by a persistently black window with stale accessibility content; Escape and CmdQ produced no visible response. This sequence included external user interaction and is not yet a controlled reproduction or evidence that the count change caused it.

The browser and chrome-renderer processes remained alive; one-second samples showed their main threads waiting in native message loops rather than a confirmed mutex deadlock. No renderer crash was logged before watchdog cleanup. Evidence target/count-ui-native.log, /tmp/dive-count-blank.sample.txt and /tmp/dive-count-chrome.sample.txt. The300second watchdog ended the run, so graceful quit did not pass. After termination, an existing CUA handle's getAXState also relaunched AppKit restore UI; that owned unconfigured process was stopped before restoration. Future computer-use calls must check that the expected test PID is alive and has ample watchdog time, including state reads. All owned browser and loopback fixture processes are stopped.

Count correction is source-reviewed/regression-tested and directly observed; full UI interaction qualification remains open. Next native diagnostics should distinguish Chrome document responsiveness, native visibility/bounds/focus, and CEF scheduling from capture/automation artifacts. Do not claim production readiness or a fixed blank-window cause.
