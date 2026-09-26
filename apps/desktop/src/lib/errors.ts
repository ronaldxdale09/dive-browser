/** The text of a thrown value: an Error's message, anything else stringified. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether a refusal is about the name that was typed ("workspace name must
 * be 1-40 characters"), so the form can mark that field and send the
 * keyboard back to it rather than leave the reason floating under the form.
 */
export function aboutTheName(reason: string): boolean {
  return /\bname\b/i.test(reason);
}
