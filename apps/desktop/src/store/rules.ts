import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { Rule, RuleAction } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

/** Where a workspace's rules are: being read, read, or unreadable. */
export type RulesStatus = "loading" | "ready" | "failed";

interface RulesState {
  /** Rules per workspace, once read. */
  byWorkspace: Record<string, Rule[]>;
  status: Record<string, RulesStatus>;
  /** Read a workspace's rules; `force` reads again even when they are held. */
  load: (workspace: string, force?: boolean) => Promise<void>;
  /** Replace a workspace's rules. Resolves false, with the old rules back, when the host refused them. */
  save: (workspace: string, rules: Rule[]) => Promise<boolean>;
}

export const DEFAULT_ACTIONS: Record<RuleAction["kind"], RuleAction> = {
  block: { kind: "block" },
  mock: { kind: "mock", status: 200, content_type: "application/json", body: "{}" },
  header: { kind: "header", name: "X-Debug", value: "1" },
};

/**
 * A rule to fill in. It starts off: a rule that is live the moment it appears
 * would block every API call in the workspace before the pattern is typed.
 */
export function newRule(): Rule {
  return { id: crypto.randomUUID(), pattern: "https://*/api/*", enabled: false, action: DEFAULT_ACTIONS.block };
}

/** An HTTP token, as a header name must be. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * What is wrong with a rule, in the words the panel shows, or null. The host
 * checks the same things and refuses the whole list over one bad rule, so
 * they are caught here, before a save, rather than as an error after it.
 */
export function ruleProblem(rule: Rule): string | null {
  if (!rule.pattern.trim()) return "Give the rule a URL pattern.";
  switch (rule.action.kind) {
    case "mock":
      if (!Number.isInteger(rule.action.status) || rule.action.status < 100 || rule.action.status > 599) return "The status must be a number from 100 to 599.";
      if (!rule.action.content_type.trim() || /[\r\n]/.test(rule.action.content_type)) return "Give the response a content type.";
      return null;
    case "header":
      if (!TOKEN.test(rule.action.name.trim())) return "A header name is letters, digits and - _ . only, with no spaces.";
      if (/[\r\n]/.test(rule.action.value)) return "A header value cannot span lines.";
      return null;
    case "block":
      return null;
  }
}

export const useRules = create<RulesState>((set, get) => ({
  byWorkspace: {},
  status: {},
  load: async (workspace, force = false) => {
    if (!force && (get().byWorkspace[workspace] || get().status[workspace] === "loading")) return;
    if (!get().byWorkspace[workspace]) set((s) => ({ status: { ...s.status, [workspace]: "loading" } }));
    try {
      const rules = await ipc.rulesList(workspace);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspace]: rules }, status: { ...s.status, [workspace]: "ready" } }));
    } catch (e) {
      // Rules we could not read are not "no rules": adding one to an empty
      // list and saving it would replace whatever is really there.
      if (!get().byWorkspace[workspace]) set((s) => ({ status: { ...s.status, [workspace]: "failed" } }));
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  save: async (workspace, rules) => {
    const before = get().byWorkspace[workspace];
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspace]: rules } }));
    try {
      await ipc.rulesSet(workspace, rules);
      return true;
    } catch (e) {
      // Put back what the host still has, so the panel does not show rules
      // that are not in force.
      if (before && get().byWorkspace[workspace] === rules) set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspace]: before } }));
      useBrowser.setState({ error: errorMessage(e) });
      return false;
    }
  },
}));

let listening: Promise<() => void> | null = null;

/**
 * Read a workspace's rules again when the agent or an MCP client replaces
 * them. The panel cached them for good, so its next edit wrote its stale
 * copy back over theirs.
 */
export function listenRules() {
  listening ??= events.rulesChanged
    .listen((e) => {
      if (e.payload.workspace in useRules.getState().byWorkspace) void useRules.getState().load(e.payload.workspace, true);
    })
    .catch(() => {
      // Without the event the panel still works; it only misses outside
      // changes until it is opened again. Let a later mount try once more.
      listening = null;
      return () => undefined;
    });
  return listening;
}

export const selectRules = (workspace: string | null) => (s: RulesState) => (workspace ? (s.byWorkspace[workspace] ?? EMPTY) : EMPTY);
export const selectRulesStatus = (workspace: string | null) => (s: RulesState) => (workspace ? s.status[workspace] : undefined);
const EMPTY: Rule[] = [];
