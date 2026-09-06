/** The text of a thrown value: an Error's message, anything else stringified. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
