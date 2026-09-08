import { Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import type { Rule, RuleAction } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { DEFAULT_ACTIONS, newRule, selectRules, useRules } from "../store/rules";
import { Icon, IconButton } from "./Icon";

const FIELD = "h-6 rounded border border-line bg-surface-2 px-1.5 font-mono text-[11px] text-ink outline-none focus:border-highlight/60";

/** Toolbar slot: add a rule. */
export function RulesTools() {
  const workspace = useBrowser((s) => s.activeWorkspace);
  const rules = useRules(selectRules(workspace));
  const save = useRules((s) => s.save);
  return <IconButton icon={Plus} label="Add rule" size={13} disabled={!workspace} onClick={() => workspace && void save(workspace, [...rules, newRule()])} />;
}

/** Mock and rewrite rules of the active workspace: block, canned response, or header. */
export function RulesPanel() {
  const workspace = useBrowser((s) => s.activeWorkspace);
  const rules = useRules(selectRules(workspace));
  const load = useRules((s) => s.load);
  const save = useRules((s) => s.save);
  useEffect(() => {
    if (workspace) void load(workspace);
  }, [workspace, load]);
  if (!workspace) return null;

  const update = (id: string, patch: Partial<Rule>) => void save(workspace, rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => void save(workspace, rules.filter((r) => r.id !== id));

  if (rules.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-xs text-ink-3">
        <p>No rules. Block requests, answer them with a canned body, or add a header, per URL pattern.</p>
        <p className="font-mono text-[11px]">https://*/api/* · *.png · https://api.dev/users/*</p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {rules.map((r) => (
        <div key={r.id} className="flex flex-col gap-1.5 border-b border-line px-3 py-2">
          <div className="flex items-center gap-2">
            <input type="checkbox" aria-label="Enabled" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} className="accent-ink" />
            <input aria-label="URL pattern" value={r.pattern} onChange={(e) => update(r.id, { pattern: e.target.value })} className={`${FIELD} min-w-0 flex-1`} spellCheck={false} />
            <select
              aria-label="Action"
              value={r.action.kind}
              onChange={(e) => update(r.id, { action: DEFAULT_ACTIONS[e.target.value as RuleAction["kind"]] })}
              className={FIELD}
            >
              <option value="block">Block</option>
              <option value="mock">Mock response</option>
              <option value="header">Add header</option>
            </select>
            <IconButton icon={Trash2} label="Delete rule" size={13} onClick={() => remove(r.id)} />
          </div>
          <ActionFields action={r.action} onChange={(action) => update(r.id, { action })} />
        </div>
      ))}
      <p className="px-3 py-2 text-[11px] text-ink-3">
        <Icon icon={Plus} size={11} className="mr-1 inline" />
        First enabled match wins. Applies to every tab in this workspace, including agent and MCP navigation.
      </p>
    </div>
  );
}

function ActionFields({ action, onChange }: { action: RuleAction; onChange: (a: RuleAction) => void }) {
  switch (action.kind) {
    case "block":
      return <p className="pl-6 text-[11px] text-ink-3">Fails with net::ERR_BLOCKED_BY_CLIENT.</p>;
    case "mock":
      return (
        <div className="flex flex-col gap-1 pl-6">
          <div className="flex items-center gap-2">
            <input aria-label="Status" type="number" min={100} max={599} value={action.status} onChange={(e) => onChange({ ...action, status: Number(e.target.value) || 200 })} className={`${FIELD} w-16`} />
            <input aria-label="Content type" value={action.content_type} onChange={(e) => onChange({ ...action, content_type: e.target.value })} className={`${FIELD} flex-1`} spellCheck={false} />
          </div>
          <textarea aria-label="Body" value={action.body} onChange={(e) => onChange({ ...action, body: e.target.value })} rows={3} className={`${FIELD} h-auto resize-y py-1`} spellCheck={false} />
        </div>
      );
    case "header":
      return (
        <div className="flex items-center gap-2 pl-6">
          <input aria-label="Header name" value={action.name} onChange={(e) => onChange({ ...action, name: e.target.value })} className={`${FIELD} w-40`} spellCheck={false} />
          <input aria-label="Header value" value={action.value} onChange={(e) => onChange({ ...action, value: e.target.value })} className={`${FIELD} flex-1`} spellCheck={false} />
        </div>
      );
  }
}
