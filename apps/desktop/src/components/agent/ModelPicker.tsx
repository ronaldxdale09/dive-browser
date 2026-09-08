import { Check, ChevronDown, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { compactNumber, shortModel } from "../../lib/agentSteps";
import type { ModelInfo, Provider } from "../../lib/ipc";
import { useCoversContent } from "../../lib/overlay";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { isReady, useAgent } from "../../store/agent";
import { usePrefs } from "../../store/prefs";
import { Icon } from "../Icon";
import { ProviderLogo } from "./ProviderLogo";

const EFFORTS = [
  { value: "default", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

/**
 * The chip in the composer that names the model, and the popover it opens:
 * switch among providers that have a key, pick a model from the provider's
 * own listing, set how hard it thinks. Everything here writes straight to
 * preferences, so Settings and the panel never disagree.
 */
export function ModelPicker({ onAddProvider }: { onAddProvider: () => void }) {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const models = useAgent((s) => s.models);
  const loading = useAgent((s) => s.modelsLoading);
  const error = useAgent((s) => s.modelsError);
  const loadModels = useAgent((s) => s.loadModels);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useCoversContent(open);
  useFocusTrap(dialog, { active: open, onEscape: () => setOpen(false) });

  const provider = providers.find((p) => p.id === prefs.agent_provider);
  const listed = models[prefs.agent_provider];
  const list = useMemo(() => listed ?? [], [listed]);
  const current = list.find((m) => m.id === prefs.agent_model);
  const usable = providers.filter((p) => isReady(p, keyed));

  useEffect(() => {
    if (open && provider?.lists_models) void loadModels(provider.id);
  }, [open, provider, loadModels]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : list;
    return rows.slice(0, 80);
  }, [list, query]);

  const switchProvider = (id: Provider) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const known = (models[id] ?? []).some((m) => m.id === prefs.agent_model);
    void update({ agent_provider: id, agent_model: known ? prefs.agent_model : p.default_model });
    setQuery("");
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-6 max-w-full items-center gap-1.5 rounded-full px-2 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink aria-expanded:bg-surface-3 aria-expanded:text-ink transition-colors"
        title="Model and provider"
      >
        {provider && <ProviderLogo id={provider.id} size={11} className="shrink-0" />}
        <span className="truncate">{current?.name ?? shortModel(prefs.agent_model)}</span>
        {provider && <span className="hidden truncate text-ink-3 sm:inline">· {provider.name}</span>}
        <Icon icon={ChevronDown} size={11} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div ref={dialog} role="dialog" aria-label="Model and provider" className="absolute bottom-full left-0 z-20 mb-2 w-[min(320px,calc(100vw-24px))] rounded-xl border border-line-2 bg-surface p-2 shadow-2xl">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {usable.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => switchProvider(p.id)}
                aria-pressed={p.id === prefs.agent_provider}
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink aria-pressed:border-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink transition-colors"
              >
                <ProviderLogo id={p.id} size={11} />
                {p.name}
              </button>
            ))}
            <button type="button" onClick={onAddProvider} className="flex h-6 shrink-0 items-center gap-0.5 rounded-full px-2 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink" title="Add a provider">
              <Icon icon={Plus} size={11} /> Add
            </button>
          </div>

          {provider?.lists_models && (
            <div className="mb-1.5 flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 focus-within:border-line-2">
              <Icon icon={Search} size={12} className="shrink-0 text-ink-3" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${list.length === 1 ? "1 model" : list.length ? `${list.length} models` : "models"}`} aria-label="Search models" className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-3" />
              <button type="button" aria-label="Refresh models" disabled={loading !== null} onClick={() => provider && void loadModels(provider.id, true)} className="grid size-5 place-items-center rounded-full text-ink-3 hover:text-ink disabled:opacity-40">
                <Icon icon={loading ? Loader2 : RefreshCw} size={11} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
              </button>
            </div>
          )}

          <div className="scroll-hidden max-h-56 overflow-y-auto">
            {error && <p className="px-2 py-1.5 text-[11px] text-danger">{error}</p>}
            {!error && loading && list.length === 0 && <p className="px-2 py-1.5 text-[11px] text-ink-3">Loading models…</p>}
            {!error && !loading && list.length === 0 && provider?.lists_models && <p className="px-2 py-1.5 text-[11px] text-ink-3">No models listed. Type a model id below.</p>}
            {filtered.map((m) => (
              <ModelRow key={m.id} model={m} selected={m.id === prefs.agent_model} onPick={() => void update({ agent_model: m.id })} />
            ))}
            {list.length > 0 && filtered.length === 0 && <p className="px-2 py-1.5 text-[11px] text-ink-3">Nothing matches.</p>}
          </div>

          <input
            key={prefs.agent_model}
            defaultValue={prefs.agent_model}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== prefs.agent_model && void update({ agent_model: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label="Model id"
            spellCheck={false}
            className="mt-1.5 h-7 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-[11px] text-ink outline-none focus:border-highlight/60"
          />

          <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
            <span className="text-[11px] text-ink-3">Thinking</span>
            <div role="radiogroup" aria-label="Reasoning effort" className="ml-auto inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
              {EFFORTS.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={prefs.agent_reasoning === o.value} onClick={() => void update({ agent_reasoning: o.value })} className="h-6 rounded-[6px] px-2 text-[11px] text-ink-2 hover:text-ink aria-checked:bg-surface-3 aria-checked:text-ink">
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRow({ model, selected, onPick }: { model: ModelInfo; selected: boolean; onPick: () => void }) {
  const detail = modelDetail(model);
  return (
    <button type="button" onClick={onPick} aria-pressed={selected} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 aria-pressed:bg-surface-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{model.name}</span>
        {detail && <span className="block truncate font-mono text-[10px] text-ink-3">{detail}</span>}
      </span>
      {selected && <Icon icon={Check} size={12} className="shrink-0 text-highlight" />}
    </button>
  );
}

/** The second line of a model row: the id when it differs from the name, then what is known about it. Empty when nothing is. */
export function modelDetail(model: ModelInfo): string {
  const price = model.input_per_mtok != null && model.output_per_mtok != null ? `$${trim(model.input_per_mtok)} / $${trim(model.output_per_mtok)}` : null;
  const parts = [
    model.id === model.name ? null : model.id,
    model.context_length ? `${compactNumber(model.context_length)} ctx` : null,
    price ? `${price} per M` : null,
    model.reasoning ? "thinks" : null,
  ].filter((p): p is string => p !== null);
  return parts.join(" · ");
}

function trim(n: number): string {
  return n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2).replace(/\.?0+$/, "");
}
