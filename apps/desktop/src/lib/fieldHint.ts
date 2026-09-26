import { createContext, useContext } from "react";

/**
 * The id of the hint under a settings row's label, for the control in that
 * row to point `aria-describedby` at. A context rather than a prop threaded
 * through every settings page: each row already knows its hint, and every
 * control in it should be described by it. Without it a screen reader read a
 * switch's name and state and never the sentence under it saying what the
 * setting does.
 */
export const FieldHint = createContext<string | undefined>(undefined);

/** The ids a control is described by: its own (an error, say) first, then its row's hint. */
export function useDescribedBy(own?: string): string | undefined {
  const hint = useContext(FieldHint);
  const ids = [own, hint].filter(Boolean).join(" ");
  return ids || undefined;
}
