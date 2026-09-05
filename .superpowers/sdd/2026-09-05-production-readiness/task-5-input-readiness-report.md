# New Tab input readiness

Run6 exact ddcc376d native computer use exposed two losses with immediate shortcut then typeText delivery: cold Settings-to-Palette dropped the text, warm page-to-Palette dropped two leading characters. No focus change was made on that observation alone.

An opt-in bounded chrome trace records performance.now event timing, command source, React Palette layout-effect mount/unmount markers and DOM event target/active tag and allowlisted role. It stores no key contents, input data/value, labels or clipboard data. A separate input-timing.request marker enables it inside the existing mock/profile-gated native sample path. The256-event copied snapshot and dropped count bound retention. Source review clear;38 focused tests then final11 after a TypeScript optional-property correction, final typecheck/ESLint pass. Three Rust UI diagnostic tests and strict Clippy pass. Evidence target/input-timing-tests-final.log, target/input-timing-final-code.log, /tmp/dive-input-timing-rust.log, /tmp/dive-input-timing-clippy.log.

Exact ecb3ac35f1fddd501cae1c8eeaef5912813578a60cc1c245a47bac381eecaa3c run8 rendered Alpha before diagnostics. Its input trace established distinct boundaries:

- Cold native-menu New Tab: command receipt at0ms, seventeen keydown events on BODY at12.4–94.7ms, Palette mounted306.2ms, combobox focused307.7ms; palette remained empty. Input arrived before the lazy Palette existed.
- Warm native-menu New Tab from the page: mount2.2ms, focus3.3ms; sixteen input events arrived in the palette. CUA sent seventeen characters. On Escape, the missing leading character was visible in the previously empty page input. This confirms misrouting across the native page/chrome focus handoff; the chrome trace did not observe that missing event.
- Warm Settings-field New Tab: keyboard command, mount2.3ms, final combobox focus3.2ms, all21 expected input events from16.9ms onward; complete typed string visible.

These are local diagnostic samples, not percentile latency benchmarks. No all-features claim is made. Run8 quit normally with helper drain after261.98seconds (session duration). Evidence target/ui-input-8/native.log and native CUA screenshots in the conversation. Cold loading and native menu focus fixes follow separately; intermittent blank rendering remains unresolved.
