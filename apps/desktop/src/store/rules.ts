import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Rule, RuleAction } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

interface RulesState {
  /** Rules per workspace, loaded on first open. */
  byWorkspace: Record<string, Rule[]>;
  load: (workspace: string) => Promise<void>;
  save: (workspace: string, rules: Rule[]) => Promise<void>;
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

export const useRules = create<RulesState>((set, get) => ({
  byWorkspace: {},
  load: async (workspace) => {
    if (get().byWorkspace[workspace]) return;
    try {
      const rules = await ipc.rulesList(workspace);
      set({ byWorkspace: { ...get().byWorkspace, [workspace]: rules } });
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  save: async (workspace, rules) => {
    set({ byWorkspace: { ...get().byWorkspace, [workspace]: rules } });
    try {
      await ipc.rulesSet(workspace, rules);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
}));

export const selectRules = (workspace: string | null) => (s: RulesState) => (workspace ? (s.byWorkspace[workspace] ?? EMPTY) : EMPTY);
const EMPTY: Rule[] = [];
