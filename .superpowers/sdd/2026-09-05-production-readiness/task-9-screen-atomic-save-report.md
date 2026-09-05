# Atomic recording project saves

The native writer previously truncated the final project path before writing. It now uses a unique sibling NamedTempFile, write_all, sync_all and atomic persist to replace the old sidecar only after the full write succeeds. Four real filesystem regressions cover injected partial write preserving old bytes, failed first save leaving no partial file, shorter whole-file replacement, and failed persist against a directory preserving its contents and cleaning the temp. RED2failed/2controls thenGREEN4: /tmp/dive-screen-project-file-{red,green}.log. Source review clear; completeRust gate460 passed.

Native17ce4e2339 verified real destination failure, retained edit across tab roundtrip, restored destination + Retry, saved current source identity/padding83, and no .tmp staging leftovers. It also exported that project successfully. Parent-directory power-loss durability and frontend pending-save flushing on immediate process Quit remain outside this slice.
