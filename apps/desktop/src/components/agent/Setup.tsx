import { ArrowLeft, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Provider, ProviderInfo } from "../../lib/ipc";
import { useAgent } from "../../store/agent";
import { pickInstalledModel } from "../../lib/modelChoice";
import { useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Icon } from "../Icon";
import { errorMessage } from "../../lib/errors";

const TOP_PROVIDERS: { id: Provider; badge?: string }[] = [
  { id: "anthropic", badge: "Recommended" },
  { id: "openai" },
  { id: "ollama", badge: "Local" },
];

/**
 * Choosing the model the agent talks to: a provider, and for the cloud
 * ones a key that goes into the Keychain. Verifies the key before it is
 * relied on, and says plainly what went wrong when it cannot.
 */
export function Setup({ canGoBack, onDone }: { canGoBack: boolean; onDone: () => void }) {
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const saveKey = useAgent((s) => s.saveKey);
  const verifyKey = useAgent((s) => s.verifyKey);
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const openTab = useBrowser((s) => s.openTab);

  const [selected, setSelected] = useState<Provider>(() => providers.find((p) => p.id === prefs.agent_provider)?.id ?? providers[0]?.id ?? "anthropic");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(prefs.agent_custom_base_url || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [verifiedSuccess, setVerifiedSuccess] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);

  const info = providers.find((p) => p.id === selected);

  const choose = (id: Provider) => {
    if (busy || !providers.some((p) => p.id === id)) return;
    attempt.current += 1;
    setSelected(id);
    setKey("");
    setResult(null);
    setVerifiedSuccess(false);
  };

  /** Make `p` the active provider and return to conversation. */
  const activate = async (p: ProviderInfo, token: number) => {
    if (attempt.current !== token) return;
    // A local server only has the models it has pulled: ask it, so the first
    // message does not fail on a default that is not installed.
    const models = p.lists_models ? await useAgent.getState().loadModels(p.id) : (useAgent.getState().models[p.id] ?? []);
    if (attempt.current !== token) return;
    const keep = prefs.agent_provider === p.id || models.some((m) => m.id === prefs.agent_model);
    const wanted = keep ? prefs.agent_model : p.default_model;
    await update({
      agent_provider: p.id,
      agent_model: pickInstalledModel(models, wanted) ?? wanted,
      ...(p.id === "custom" ? { agent_custom_base_url: baseUrl.trim() } : {}),
    }, { rejectOnError: true });
    if (attempt.current === token) onDone();
  };

  const submit = async (check: boolean) => {
    if (!info || busy) return;
    const token = ++attempt.current;
    const current = () => attempt.current === token;
    setBusy(true);
    setResult(null);
    setVerifiedSuccess(false);
    try {
      if (info.id === "custom" && !baseUrl.trim()) {
        setResult({ ok: false, message: "Please enter the API base URL for this endpoint." });
        return;
      }
      if (info.id === "custom") {
        await update({ agent_custom_base_url: baseUrl.trim() }, { rejectOnError: true });
        if (!current()) return;
      }
      if (info.needs_key && !key.trim() && !keyed.includes(info.id)) {
        setResult({ ok: false, message: "Please enter your API key to continue." });
        return;
      }
      if (check) {
        const verdict = await verifyKey(info.id, key.trim() || null);
        if (!current()) return;
        setResult(verdict);
        if (!verdict.ok) return;
        setVerifiedSuccess(true);
      }
      if (key.trim()) {
        await saveKey(info.id, key.trim());
        if (!current()) return;
      }
      await activate(info, token);
    } catch (e) {
      if (current()) {
        setVerifiedSuccess(false);
        setResult({ ok: false, message: errorMessage(e) });
      }
    } finally {
      if (current()) setBusy(false);
    }
  };

  const handlePaste = async () => {
    const token = attempt.current;
    try {
      const text = await navigator.clipboard.readText();
      if (text && token === attempt.current) setKey(text.trim());
    } catch {
      // Clipboard permissions unavailable; ignored
    }
  };

  const hasKey = info ? keyed.includes(info.id) || !info.needs_key : false;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface animate-agent-slide-up">
      {/* Top back bar when navigating back to chat */}
      {canGoBack && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <button
            type="button"
            onClick={onDone}
            aria-label="Back to chat"
            className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-ink transition-colors"
          >
            <Icon icon={ArrowLeft} size={13} />
            <span>Back to conversation</span>
          </button>
          <button
            type="button"
            onClick={onDone}
            className="text-[11px] text-ink-3 hover:text-ink transition-colors px-1"
          >
            Done
          </button>
        </div>
      )}

      {/* Main Form Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 space-y-3.5">
        {/* Onboarding Overview (shown on initial setup) */}
        {!canGoBack && keyed.length === 0 && (
          <div className="space-y-1 rounded-xl border border-line bg-surface-2/40 p-3">
            <h3 className="text-xs font-semibold text-ink">Connect a model provider</h3>
            <p className="text-[11px] leading-relaxed text-ink-2">
              The agent reads and operates the page with a model you choose: a cloud provider with your own key, or a local one such as Ollama.
            </p>
          </div>
        )}

        {/* Provider Selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
              Provider
            </span>
            {hasKey && (
              <span className="text-[11px] font-medium text-highlight">
                {info?.needs_key ? "Connected" : "Ready"}
              </span>
            )}
          </div>

          {/* Quick-select top providers */}
          <div className="grid grid-cols-3 gap-1.5">
            {TOP_PROVIDERS.filter((tp) => providers.some((p) => p.id === tp.id)).map((tp) => {
              const isSelected = selected === tp.id;
              return (
                <button
                  key={tp.id}
                  type="button"
                  disabled={busy}
                  onClick={() => choose(tp.id)}
                  className={`flex flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                    isSelected
                      ? "border-line-2 bg-surface-2 text-ink shadow-2xs"
                      : "border-line/60 bg-surface-2/40 text-ink-2 hover:border-line-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <span className="text-xs font-medium truncate w-full">{providers.find((p) => p.id === tp.id)?.name}</span>
                  <span className="mt-0.5 text-[11px] text-ink-3">
                    {tp.badge || "Cloud"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Full provider dropdown */}
          <div className="relative">
            <select
              id="agent-provider-select"
              aria-label="All providers"
              value={selected}
              disabled={busy}
              onChange={(e) => choose(e.target.value as Provider)}
              className="w-full appearance-none rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none transition-colors hover:border-line-2 focus:border-highlight pr-7 cursor-pointer"
            >
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3">
              <Icon icon={ChevronDown} size={13} />
            </div>
          </div>
        </div>

        {/* Selected Provider Form */}
        {info && (
          <form
            className="space-y-3 pt-1 border-t border-line/60"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(true);
            }}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="text-[11px] text-ink-3">
                Default model: <code className="font-mono text-ink text-[10.5px]">{info.default_model}</code>
              </span>

              {info.key_url && (
                <button
                  type="button"
                  onClick={() => void openTab(info.key_url)}
                  className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink hover:underline transition-colors"
                  title={info.key_url}
                >
                  <span>Get an API key</span>
                  <Icon icon={ExternalLink} size={10} />
                </button>
              )}
            </div>

            {/* Custom Endpoint Base URL */}
            {info.id === "custom" && (
              <div>
                <label htmlFor="agent-base-url" className="block text-[11px] font-medium text-ink-2 mb-1">
                  API Base URL
                </label>
                <input
                  id="agent-base-url"
                  disabled={busy}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60 transition-colors"
                />
              </div>
            )}

            {/* API Key Input */}
            {info.needs_key || info.id === "custom" ? (
              <div>
                <label htmlFor="agent-api-key" className="block text-[11px] font-medium text-ink-2 mb-1">
                  API key
                </label>
                <div className="relative flex items-center">
                  <input
                    id="agent-api-key"
                    disabled={busy}
                    type={showKey ? "text" : "password"}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={
                      keyed.includes(info.id)
                        ? "Key saved · paste to replace"
                        : info.key_hint || (info.id === "custom" ? "sk-... (optional)" : "sk-...")
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60 transition-colors pr-16"
                  />
                  <div className="absolute right-1 flex items-center gap-0.5">
                    {key && (
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="px-1.5 py-0.5 text-[10px] text-ink-3 hover:text-ink"
                      >
                        {showKey ? "Hide" : "Show"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handlePaste}
                      disabled={busy}
                      className="px-1.5 py-0.5 text-[10px] text-ink-3 hover:text-ink"
                    >
                      Paste
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-[10.5px] text-ink-3">
                  Encrypted and stored in macOS Keychain.
                </p>
              </div>
            ) : (
              /* Local Provider Notice */
              <div className="rounded-lg border border-line bg-surface-2/60 p-2.5 text-xs text-ink-2 space-y-1">
                <span className="font-medium text-ink block">Local & Offline Model</span>
                <p className="text-[11px] text-ink-3 leading-relaxed">
                  No API key required. Make sure {info.name} is running at{" "}
                  <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px] text-ink">
                    {info.base_url}
                  </code>{" "}
                  with a tool-capable model (e.g. <span className="text-ink font-mono">llama3.3</span>).
                </p>
              </div>
            )}

            {/* Success state */}
            {verifiedSuccess && (
              <div className="text-[11px] text-highlight font-medium">
                Connection verified! Loading agent…
              </div>
            )}

            {/* Error state */}
            {result && !result.ok && (
              <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger space-y-0.5">
                <span className="font-medium">Could not connect:</span>
                <p className="text-[10.5px] opacity-90">{result.message}</p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="pt-1 flex items-center justify-between gap-2">
              {result && !result.ok && (info.needs_key || info.id === "custom") ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit(false)}
                  className="text-[11px] text-ink-3 hover:text-ink transition-colors disabled:opacity-40"
                >
                  Save without verifying
                </button>
              ) : (
                <span />
              )}

              <button
                type="submit"
                disabled={busy || (info.needs_key && !key.trim() && !hasKey)}
                className="h-8 rounded-lg bg-accent px-4 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40 transition-opacity flex items-center gap-1.5"
              >
                {busy ? (
                  <>
                    <Icon icon={Loader2} size={11} className="animate-spin motion-reduce:animate-none" />
                    <span>Verifying…</span>
                  </>
                ) : verifiedSuccess ? (
                  "Connected"
                ) : info.needs_key ? (
                  hasKey && !key.trim() ? (
                    "Use Provider"
                  ) : (
                    "Verify and connect"
                  )
                ) : (
                  "Connect provider"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
