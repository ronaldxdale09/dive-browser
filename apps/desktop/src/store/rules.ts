import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Rule, RuleAction } from "../lib/ipc";
import { useBrowser } from "./browser";

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

export function newRule(): Rule {
  return { id: crypto.randomUUID(), pattern: "https://*/api/*", enabled: true, action: DEFAULT_ACTIONS.block };
}

export const useRules = create<RulesState>((set, get) => ({
  byWorkspace: {},
  load: async (workspace) => {
    if (get().byWorkspace[workspace]) return;
    try {
      const rules = await ipc.rulesList(workspace);
      set({ byWorkspace: { ...get().byWorkspace, [workspace]: rules } });
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  save: async (workspace, rules) => {
    set({ byWorkspace: { ...get().byWorkspace, [workspace]: rules } });
    try {
      await ipc.rulesSet(workspace, rules);
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

export const selectRules = (workspace: string | null) => (s: RulesState) => (workspace ? (s.byWorkspace[workspace] ?? EMPTY) : EMPTY);
const EMPTY: Rule[] = [];
