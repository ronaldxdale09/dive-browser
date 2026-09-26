/**
 * What the chrome says to a screen reader, through two live regions that are
 * always in the document (`LiveRegions` in ChromeFeedback).
 *
 * A live region only speaks about changes it was present for. The toasts,
 * the recording status and the agent's approvals each used to bring their
 * own region in with the message, so the region and its text arrived in one
 * change and most screen readers said nothing. Writing into regions that
 * were mounted with the chrome makes every message a change to something
 * already being watched.
 */
export type Urgency = "polite" | "assertive";

/** One message; the id makes the same words said twice a new change. */
export type Announcement = { text: string; id: number };

type Regions = Record<Urgency, Announcement | null>;

let regions: Regions = { polite: null, assertive: null };
let sequence = 0;
const listeners = new Set<() => void>();

/**
 * Say `text` to assistive technology. Polite waits for a pause in speech;
 * assertive interrupts, and is kept for failures the person has to act on.
 */
export function announce(text: string, urgency: Urgency = "polite"): void {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) return;
  regions = { ...regions, [urgency]: { text: words, id: ++sequence } };
  for (const listener of listeners) listener();
}

/** Clear one region once its message has been said, so a reader browsing later does not meet it stale. */
export function clearAnnouncement(urgency: Urgency, id: number): void {
  if (regions[urgency]?.id !== id) return;
  regions = { ...regions, [urgency]: null };
  for (const listener of listeners) listener();
}

export function subscribeAnnouncements(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentAnnouncements(): Regions {
  return regions;
}

/** Tests start from silence. */
export function resetAnnouncements(): void {
  regions = { polite: null, assertive: null };
  for (const listener of listeners) listener();
}
