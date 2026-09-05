# Capture input correction and native verification

## Root causes

A local plain-canvas control received pointerdown/mousedown/pointerup/mouseup/click from computer use. A disposable diagnostic then observed the same trusted events and React handler at the capture canvas. Logs target/input-trace-native.log and target/input-trace2-native.log.

Text pointerdown created and autofocus selected the annotation input. The following compatibility mousedown on the canvas caused focusout, committing an empty value and removing the input before pointerup. Fast CUA drag emitted down/move/up, but React's continuous move state was not committed before the discrete release read the old draft. These are separate focus and state-timing defects, not a missing native pointer stream or hidden sibling view.

## Changes

- Canvas pointerdown prevents default compatibility mouse focus transfer.
- A ref owns the synchronous active gesture; React state only drives its rendered preview. Release includes its final coordinates even when move updates have not rendered. Cancellation clears both.
- Pen/highlight paths preserve intermediate batched points, including closed strokes that return to the starting point.
- Temporary native tracing was removed after diagnosis. No diagnostic hook or input log is present in the final source/build.

## Verification

Two initial regression tests failed; additional pen/highlight loop tests failed before validity correction. Twelve focused capture tests pass; full frontend690 pass/one opt-in benchmark skipped. TypeScript, focused ESLint, source review and diff checks pass. Nine workflow tests independently rerun by reviewer.

Exact native b24effa892c010cf35532369a6459d7528e4378b3ab7fae9d086e4a927117bcf, target/canvas-fixed-native.log:

- Text placement retained the focused input, accepted Verified annotation, and rendered one edit.
- Same previously failing fast drag committed a visible rectangle; arrow, pen, highlight and blur each rendered and advanced the edit count.
- Crop produced827x629; Undo removed it and Redo restored it.
- Export PNG completed with a Saved download. The actual827x629 PNG was opened and visually inspected: text, rectangle, arrow, pen, highlight, blur and crop survived export. File /Users/dvle/Downloads/pointer-input-control-full-page (1).png.
- Reset cleared all7 edits and restored disabled Undo. Normal Quit/helper drain passed;132.48s is total interactive session duration, not shutdown latency.
- Disposable profile, mock keychains and AppKit ignore-state launch arguments used; no password prompt. The loopback fixture server was stopped after testing.

This closes the reproduced capture text/fast-drag failures. The full production-readiness goal remains open: memory reclamation, permissions/legacy migration and remaining feature/release coverage are not qualified by these tests.
