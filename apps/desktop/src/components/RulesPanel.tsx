import { Select } from "./Select";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Rule, RuleAction } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { DEFAULT_ACTIONS, listenRules, newRule, ruleProblem, selectRules, selectRulesStatus, useRules } from "../store/rules";
import { Icon, IconButton } from "./Icon";

const FIELD = "h-6 rounded border border-line bg-surface-2 px-1.5 font-mono text-[11px] text-ink outline-none focus:border-highlight/60";

/** How long typing pauses before a rule is saved. */
export const SAVE_AFTER_MS = 400;

/** Toolbar slot: add a rule. */
export function RulesTools() {
  const workspace = useBrowser((s) => s.activeWorkspace);
  const status = useRules(selectRulesStatus(workspace));
  const save = useRules((s) => s.save);
  // Only once the workspace's rules have been read: adding to a list that
  // failed to load, or has not loaded yet, would save one rule over all of them.
  const ready = status === "ready";
  return (
    <IconButton
      icon={Plus}
      label={ready ? "Add rule" : status === "failed" ? "Rules could not be read" : "Reading rules…"}
      size={13}
      disabled={!workspace || !ready}
      onClick={() => workspace && void save(workspace, [...(useRules.getState().byWorkspace[workspace] ?? []), newRule()])}
    />
  );
}

/** Mock and rewrite rules of the active workspace: block, canned response, or header. */
export function RulesPanel() {
  const workspace = useBrowser((s) => s.activeWorkspace);
  const rules = useRules(selectRules(workspace));
  const status = useRules(selectRulesStatus(workspace));
  const load = useRules((s) => s.load);
  const save = useRules((s) => s.save);
  useEffect(() => {
    void listenRules();
  }, []);
  useEffect(() => {
    if (workspace) void load(workspace);
  }, [workspace, load]);
  // A rule just added is the last one; its pattern is what the person types next.
  const list = useRef<HTMLDivElement>(null);
  const count = useRef(rules.length);
  useEffect(() => {
    const grew = rules.length > count.current;
    count.current = rules.length;
    if (!grew) return;
    const inputs = list.current?.querySelectorAll<HTMLInputElement>('input[aria-label="URL pattern"]');
    const last = inputs?.[inputs.length - 1];
    last?.focus();
    last?.select();
  }, [rules.length]);
  if (!workspace) return null;

  // Every write starts from the rules as they are now, not as this render saw
  // them: two rows saving a moment apart must not undo each other.
  const current = () => useRules.getState().byWorkspace[workspace] ?? [];
  const update = (next: Rule) => save(workspace, current().map((r) => (r.id === next.id ? next : r)));
  const remove = (id: string) => void save(workspace, current().filter((r) => r.id !== id));

  if (status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-ink-3">
        <p>This workspace&rsquo;s rules could not be read.</p>
        <button type="button" onClick={() => void load(workspace, true)} className="pressable rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
          Try again
        </button>
      </div>
    );
  }
  if (status !== "ready" && rules.length === 0) return <div className="px-3 py-2 text-xs text-ink-3">Reading rules…</div>;
  if (rules.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-xs text-ink-3">
        <p>No rules. Block requests, answer them with a canned body, or add a header, per URL pattern.</p>
        <p className="font-mono text-[11px]">https://*/api/* · *.png · https://api.dev/users/*</p>
      </div>
    );
  }
  return (
    <div ref={list} className="min-h-0 flex-1 overflow-auto">
      {rules.map((r) => (
        <RuleRow key={r.id} rule={r} onSave={update} onRemove={() => remove(r.id)} />
      ))}
      <p className="px-3 py-2 text-[11px] text-ink-3">
        <Icon icon={Plus} size={11} className="mr-1 inline" />
        First enabled match wins. Applies to this workspace's tabs, including agent and MCP navigation. Media is not intercepted.
      </p>
    </div>
  );
}

/**
 * One rule, edited in place.
 *
 * What is typed is kept here and saved when typing pauses or the field loses
 * focus. Saving on every keystroke sent the whole list to the host and
 * re-armed interception on every tab each time, and a half-typed value -- an
 * empty status, a header name with a space in it -- was refused and reported
 * as an error before it was finished. A rule the host refuses goes back to
 * what is in force.
 */
function RuleRow({ rule, onSave, onRemove }: { rule: Rule; onSave: (rule: Rule) => Promise<boolean>; onRemove: () => void }) {
  const [draft, setDraft] = useState(rule);
  const [statusText, setStatusText] = useState(rule.action.kind === "mock" ? String(rule.action.status) : "");
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Someone else changed the rule -- the agent, a revert after a refused
  // save. Take it, unless the person is in the middle of typing into it.
  const [seen, setSeen] = useState(rule);
  if (seen !== rule) {
    setSeen(rule);
    if (!editing) {
      setDraft(rule);
      setStatusText(rule.action.kind === "mock" ? String(rule.action.status) : "");
    }
  }
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; next: Rule } | null>(null);

  const commit = async (next: Rule) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    const why = ruleProblem(next);
    setProblem(why);
    if (why) return;
    setEditing(false);
    if (next === rule) return;
    if (!(await onSave(next))) {
      setDraft(rule);
      setStatusText(rule.action.kind === "mock" ? String(rule.action.status) : "");
    }
  };
  // A switch or a menu is one decision and is saved at once; text waits for
  // a pause in the typing.
  const change = (patch: Partial<Rule>, now = false) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (now) {
      void commit(next);
      return;
    }
    setEditing(true);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { next, timer: setTimeout(() => void commit(next), SAVE_AFTER_MS) };
  };
  const flush = () => {
    if (pending.current) void commit(pending.current.next);
  };
  // Closing the panel mid-edit still saves what was typed.
  useEffect(
    () => () => {
      const waiting = pending.current;
      if (!waiting) return;
      clearTimeout(waiting.timer);
      if (!ruleProblem(waiting.next)) void onSave(waiting.next);
    },
    // Unmount only; `onSave` reads the store when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2" onBlur={flush}>
      <div className="flex items-center gap-2">
        <input type="checkbox" aria-label="Enabled" title={draft.enabled ? "On. Untick to keep the rule without applying it." : "Off. Tick once the pattern is ready."} checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked }, true)} className="accent-ink" />
        <input aria-label="URL pattern" value={draft.pattern} onChange={(e) => change({ pattern: e.target.value })} className={`${FIELD} min-w-0 flex-1`} spellCheck={false} />
        <Select
          label="Action"
          value={draft.action.kind}
          onChange={(value) => {
            const action = DEFAULT_ACTIONS[value];
            setStatusText(action.kind === "mock" ? String(action.status) : "");
            change({ action }, true);
          }}
          className={FIELD}
          options={[{ value: "block", label: "Block" }, { value: "mock", label: "Mock response" }, { value: "header", label: "Add header" }]}
        />
        <IconButton icon={Trash2} label="Delete rule" size={13} onClick={onRemove} />
      </div>
      <ActionFields
        action={draft.action}
        statusText={statusText}
        onStatusText={(text) => {
          setStatusText(text);
          if (draft.action.kind !== "mock") return;
          // An empty or half-typed status stays in the field; it is only a
          // number once it reads as one.
          const status = /^\d+$/.test(text.trim()) ? Number(text) : Number.NaN;
          change({ action: { ...draft.action, status } });
        }}
        onChange={(action) => change({ action })}
      />
      {problem && (
        <p role="alert" className="pl-6 text-[11px] text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

function ActionFields({ action, statusText, onStatusText, onChange }: { action: RuleAction; statusText: string; onStatusText: (text: string) => void; onChange: (a: RuleAction) => void }) {
  switch (action.kind) {
    case "block":
      return <p className="pl-6 text-[11px] text-ink-3">Fails with net::ERR_BLOCKED_BY_CLIENT.</p>;
    case "mock":
      return (
        <div className="flex flex-col gap-1 pl-6">
          <div className="flex items-center gap-2">
            <input aria-label="Status" inputMode="numeric" value={statusText} onChange={(e) => onStatusText(e.target.value)} className={`${FIELD} w-16`} />
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
