import type { ErrorKind } from "../generated/bindings";

/** The text of a thrown value: an Error's message, anything else stringified. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The kind the host attached to a failure, or null. Read structurally, so an
 * `IpcError` and anything carrying the host's `kind` both qualify; the
 * chrome acts on this rather than on the words of the message.
 */
export function errorKind(e: unknown): ErrorKind | null {
  if (typeof e !== "object" || e === null || !("kind" in e)) return null;
  const kind = (e as { kind: unknown }).kind;
  if (typeof kind !== "object" || kind === null || !("type" in kind)) return null;
  return kind as ErrorKind;
}

/**
 * The input a refusal is about ("name", "month", ...), or null when the
 * failure is not a refused value. A form marks that field and sends the
 * keyboard back to it rather than leave the reason floating under the form.
 */
export function invalidField(e: unknown): string | null {
  const kind = errorKind(e);
  return kind?.type === "invalid" ? kind.field : null;
}
