## What this changes

<!-- One concern per PR. Say what it does for the user, and why, when the diff
does not make that obvious. -->

## How it was verified

<!-- Be precise about which of these you actually did. -->

- [ ] `pnpm check` passes locally
- [ ] Regenerated bindings committed if a Rust command signature changed
      (`apps/desktop/src/generated`)
- [ ] Driven in a live window / bundle (say which script or steps)
- [ ] Not applicable: docs / tooling only

## Notes for the reviewer

<!-- New dependencies need a reason. Anything touching CEF view lifecycle,
threading (`run_on_main_thread`), or the MCP surface should say so here. -->
