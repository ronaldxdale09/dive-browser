import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * A key press that belongs to an input method composing text: Enter there
 * confirms a candidate and Escape cancels one. Neither is a request to
 * submit, close or step. Chromium flags these with `isComposing` and the
 * legacy keyCode 229; checking both covers every engine.
 */
export function isImeComposing(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
