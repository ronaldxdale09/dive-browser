import { ArrowLeft, Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import type { Provider, ProviderInfo } from "../../lib/ipc";
import { useAgent } from "../../store/agent";
import { useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Icon } from "../Icon";

/**
 * Bring your own key. Pick a provider, paste a key, and it is checked against
 * the provider before it is kept -- a typo surfaces here rather than as the
 * first reply failing. Local servers and custom endpoints take no key.
 */
export function Setup({ canGoBack, onDone }: { canGoBack: boolean; onDone: () => void }) {
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const saveKey = useAgent((s) => s.saveKey);
  const verifyKey = useAgent((s) => s.verifyKey);
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const openTab = useBrowser((s) => s.openTab);

  const [selected, setSelected] = useState<Provider>(prefs.agent_provider as Provider);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(prefs.agent_custom_base_url);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const info = providers.find((p) => p.id === selected);
  const choose = (id: Provider) => {
    setSelected(id);
    setKey("");
    setResult(null);
  };

  /** Make `p` the active provider, moving the model to its default when the
   *  current one belongs to another provider's naming. */
  const activate = async (p: ProviderInfo) => {
    const models = useAgent.getState().models[p.id] ?? [];
    const keep = prefs.agent_provider === p.id || models.some((m) => m.id === prefs.agent_model);
    await update({ agent_provider: p.id, agent_model: keep ? prefs.agent_model : p.default_model, ...(p.id === "custom" ? { agent_custom_base_url: baseUrl.trim() } : {}) });
    onDone();
  };

  const submit = async (check: boolean) => {
    if (!info) return;
    setBusy(true);
    setResult(null);
    try {
      if (info.id === "custom" && !baseUrl.trim()) {
        setResult({ ok: false, message: "Enter the base URL of the endpoint." });
        return;
      }
      if (info.id === "custom") await update({ agent_custom_base_url: baseUrl.trim() });
      if (info.needs_key && !key.trim() && !keyed.includes(info.id)) {
        setResult({ ok: false, message: "Paste a key first." });
        return;
      }
      if (check) {
        const verdict = await verifyKey(info.id, key.trim() || null);
        setResult(verdict);
        if (!verdict.ok) return;
      }
      if (key.trim()) await saveKey(info.id, key.trim());
      await activate(info);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        {canGoBack && (
          <button type="button" onClick={onDone} aria-label="Back to the conversation" className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
            <Icon icon={ArrowLeft} size={13} />
          </button>
        )}
        <div>
          <h3 className="text-xs font-semibold text-ink">Bring your own key</h3>
          <p className="text-[11px] text-ink-3">Keys stay in your OS keychain and leave this Mac only in calls to the provider you chose.</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Provider" className="scroll-hidden min-h-0 flex-1 overflow-y-auto px-2">
        {providers.map((p) => {
          const active = p.id === selected;
          const has = keyed.includes(p.id) || !p.needs_key;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(p.id)}
              className={`mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${active ? "bg-surface-3 ring-1 ring-line-2" : "hover:bg-surface-2"}`}
            >
              <span className={`grid size-7 shrink-0 place-items-center rounded-lg text-[11px] font-semibold ${active ? "bg-highlight-soft text-highlight" : "bg-surface-2 text-ink-2"}`}>{p.name.slice(0, 1)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs text-ink">
                  {p.name}
                  {has && (
                    <span className="flex items-center gap-0.5 rounded-full bg-highlight-soft px-1.5 text-[9px] tracking-wider text-highlight uppercase">
                      <Icon icon={Check} size={9} /> {p.needs_key ? "key" : "local"}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-ink-3">{p.note}</span>
              </span>
            </button>
          );
        })}
      </div>

      {info && (
        <form
          className="border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(true);
          }}
        >
          {info.id === "custom" && (
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://host/v1"
              spellCheck={false}
              aria-label="Base URL"
              className="mb-2 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-line-2"
            />
          )}
          {info.needs_key || info.id === "custom" ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 pr-2 pl-3 focus-within:border-line-2">
              <Icon icon={KeyRound} size={13} className="shrink-0 text-ink-3" />
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={keyed.includes(info.id) ? "Key saved · paste to replace" : info.key_hint || (info.id === "custom" ? "API key (optional)" : "API key")}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${info.name} API key`}
                className="h-9 min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3"
              />
              {info.key_url && (
                <button type="button" onClick={() => void openTab(info.key_url)} className="flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink" title={info.key_url}>
                  Get a key <Icon icon={ExternalLink} size={10} />
                </button>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-2">
              No key needed. Make sure {info.name} is running at <code className="font-mono text-ink">{info.base_url}</code> with a model that supports tools.
            </p>
          )}
          {result && <p className={`mt-2 text-[11px] ${result.ok ? "text-highlight" : "text-danger"}`}>{result.message}</p>}
          <div className="mt-2.5 flex items-center gap-2">
            {result && !result.ok && (info.needs_key || info.id === "custom") && (
              <button type="button" disabled={busy} onClick={() => void submit(false)} className="text-[11px] text-ink-3 hover:text-ink disabled:opacity-40">
                Save without checking
              </button>
            )}
            <span className="flex-1" />
            <button type="submit" disabled={busy} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40">
              {busy && <Icon icon={Loader2} size={12} className="animate-spin" />}
              {info.needs_key ? (keyed.includes(info.id) && !key.trim() ? "Use this provider" : "Verify and save") : "Use this provider"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
