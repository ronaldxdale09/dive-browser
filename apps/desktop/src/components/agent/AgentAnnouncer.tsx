import { useEffect } from "react";
import { announce } from "../../lib/announce";
import type { Urgency } from "../../lib/announce";
import { displayChord } from "../../lib/commands";
import { useAgent } from "../../store/agent";
import type { Message } from "../../store/agent";
import { useBrowser } from "../../store/browser";

/** Longest opening of a reply that is read out; the rest is in the transcript. */
const OPENING_MAX = 200;

/**
 * The first sentence of a reply, as plain words: Markdown's marks read
 * aloud as "asterisk asterisk" and a code block as its punctuation.
 */
export function openingSentence(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  return sentence.length > OPENING_MAX ? `${sentence.slice(0, OPENING_MAX - 1).trimEnd()}…` : sentence;
}

/** "Click the link" from a step's caution, as the approval row words it. */
function sentence(caution: string | null | undefined): string {
  if (!caution) return "This changes the page";
  return `${caution[0]?.toUpperCase() ?? ""}${caution.slice(1)}`;
}

/**
 * What changed in the conversation that someone who cannot see the dock
 * needs to hear: a step waiting for Allow, and a reply that has finished,
 * failed or stopped. Only a message present before and after counts, so
 * loading another tab's conversation says nothing about its history.
 */
export function agentAnnouncements(prev: readonly Message[], next: readonly Message[], panelOpen: boolean): { text: string; urgency: Urgency }[] {
  const out: { text: string; urgency: Urgency }[] = [];
  const before = new Map(prev.map((m) => [m.id, m]));
  for (const message of next) {
    const was = before.get(message.id);
    if (!was || message.role !== "assistant") continue;
    const waiting = new Set((was.steps ?? []).filter((s) => s.awaiting).map((s) => s.id));
    for (const step of message.steps ?? []) {
      if (!step.awaiting || waiting.has(step.id)) continue;
      // With the dock closed the Allow and Deny are out of reach; the chord
      // that brings them back is part of the message.
      const reach = panelOpen ? "" : ` Press ${displayChord("⌘J")} to answer.`;
      out.push({ text: `Agent needs approval: ${sentence(step.caution)}.${reach}`, urgency: "polite" });
    }
    if (!was.pending || message.pending) continue;
    if (message.error) out.push({ text: `Agent reply failed: ${message.error}`, urgency: "assertive" });
    else if (message.stopped) out.push({ text: "Agent reply stopped", urgency: "polite" });
    else {
      const opening = openingSentence(message.content);
      out.push({ text: opening ? `Reply finished. ${opening}` : "Reply finished", urgency: "polite" });
    }
  }
  return out;
}

/**
 * Says what the agent needs and what it answered, whether or not the dock is
 * open: a run carries on with the panel closed, and so does a step waiting
 * for approval, which times out unseen if nobody hears about it. The
 * transcript itself is not a live region; read as it streamed, every token
 * would be spoken.
 */
export function AgentAnnouncer() {
  useEffect(
    () =>
      useAgent.subscribe((state, prev) => {
        if (state.messages === prev.messages) return;
        const open = useBrowser.getState().open.sidecar;
        const said = agentAnnouncements(prev.messages, state.messages, open);
        // A region says only its newest words, so two things at once are one message.
        for (const urgency of ["polite", "assertive"] as const) {
          const text = said.filter((s) => s.urgency === urgency).map((s) => s.text).join(" ");
          if (text) announce(text, urgency);
        }
      }),
    [],
  );
  return null;
}
