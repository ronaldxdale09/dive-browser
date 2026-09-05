/** Keep macOS Select All ahead of subsequent input in Dive's own text fields. */
export function selectAllInChromeField(event: KeyboardEvent, mac: boolean): boolean {
  if (!mac || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.key.toLowerCase() !== "a" || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const field = event.target;
  if (field !== document.activeElement) return false;
  if (!(field instanceof HTMLTextAreaElement) && !(field instanceof HTMLInputElement && ["text", "search", "url", "tel", "password"].includes(field.type))) return false;
  if (field.disabled) return false;
  // CEF's renderer fallback reaches native Select All asynchronously. Mark this
  // handled in the chrome renderer so it cannot overwrite the next insertion.
  field.select();
  event.preventDefault();
  return true;
}
