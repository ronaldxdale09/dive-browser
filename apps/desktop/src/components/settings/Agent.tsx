import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderInfo } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { isReady, useAgent } from "../../store/agent";
import { Icon } from "../Icon";
import { Button, Group, Row, Segmented, Select, Switch, TextInput } from "../SettingsFields";
import { usePref } from "./usePref";

const EFFORTS = [
  { value: "default", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

const STEP_LIMITS = ["10", "25", "50", "100", "200"] as const;

/** Settings › Agent: provider, model, behaviour and API keys. */
export function Agent() {
  const [prefs, set] = usePref();
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const models = useAgent((s) => s.models);
  const loading = useAgent((s) => s.modelsLoading);
  const modelsError = useAgent((s) => s.modelsError);
  const loadModels = useAgent((s) => s.loadModels);
  const init = useAgent((s) => s.init);
  useEffect(() => void init(), [init]);
  const provider = providers.find((p) => p.id === prefs.agent_provider);
  const ready = isReady(provider, keyed);
  useEffect(() => {
    if (provider?.lists_models && ready) void loadModels(provider.id);
  }, [provider, ready, loadModels]);
  const list = models[prefs.agent_provider] ?? [];
  const known = list.some((m) => m.id === prefs.agent_model);
  const modelOptions = [...(known ? [] : [{ value: prefs.agent_model, label: prefs.agent_model }]), ...list.map((m) => ({ value: m.id, label: m.name }))];

  const switchProvider = (id: string) => {
    const next = providers.find((p) => p.id === id);
    if (!next) return;
    const keep = (models[id] ?? []).some((m) => m.id === prefs.agent_model);
    set({ agent_provider: id, agent_model: keep ? prefs.agent_model : next.default_model });
  };

  return (
    <>
      <Group title="Provider and model" description="Bring your own key. Two protocols cover every provider here, so switching is a matter of picking one.">
        <Row
          label="Provider"
          htmlFor="pref-provider"
          hint={provider ? (ready ? provider.note : `${provider.note} No key yet: add one below.`) : undefined}
          control={
            <Select
              id="pref-provider"
              label="Provider"
              value={prefs.agent_provider}
              onChange={switchProvider}
              options={providers.map((p) => ({ value: p.id, label: `${p.name}${keyed.includes(p.id) ? " · key saved" : !p.needs_key ? " · local" : ""}` }))}
            />
          }
        />
        {provider?.id === "custom" && (
          <Row
            label="Base URL"
            htmlFor="pref-agent-base"
            hint="Any OpenAI-compatible server. Most end in /v1."
            control={<TextInput id="pref-agent-base" mono label="Base URL" value={prefs.agent_custom_base_url} placeholder="https://host/v1" onCommit={(agent_custom_base_url) => set({ agent_custom_base_url })} />}
          />
        )}
        <Row
          label="Model"
          htmlFor="pref-model"
          hint={
            modelsError
              ? modelsError
              : list.length
                ? `${list.length} ${list.length === 1 ? "model" : "models"} listed by ${provider?.name ?? "the provider"}${loading ? ", refreshing…" : "."}`
                : provider && !ready
                  ? "Models are listed once a key is saved."
                  : "Type the id exactly as the provider names it."
          }
          control={
            list.length ? (
              <span className="flex items-center gap-2">
                <Select id="pref-model" label="Model" value={prefs.agent_model} onChange={(agent_model) => set({ agent_model })} options={modelOptions} />
                <Button variant="quiet" disabled={loading !== null} onClick={() => provider && void loadModels(provider.id, true)}>
                  Refresh
                </Button>
              </span>
            ) : (
              <TextInput id="pref-model" mono label="Model" value={prefs.agent_model} placeholder={provider?.default_model || "model id"} onCommit={(agent_model) => set({ agent_model })} />
            )
          }
        />
        <Row
          label="Thinking"
          hint="How hard the model reasons before it acts. Auto leaves it to the provider; higher settings are slower and cost more, and not every model supports them."
          control={<Segmented label="Thinking" value={prefs.agent_reasoning} onChange={(agent_reasoning) => set({ agent_reasoning })} options={EFFORTS} />}
        />
      </Group>

      <Group title="Behaviour">
        <Row
          label="Act without asking"
          hint="Off, every click, keystroke or navigation the agent wants waits for you. A page can steer the model, so leave this off unless you are watching."
          control={<Switch label="Act without asking" checked={prefs.agent_auto_approve} onChange={(agent_auto_approve) => set({ agent_auto_approve })} />}
        />
        <Row
          label="Send page context"
          hint="The tab's title, URL, recent console, failed requests and visible text go with each message. Off saves tokens; the agent can still read the page with its tools."
          control={<Switch label="Send page context" checked={prefs.agent_include_page} onChange={(agent_include_page) => set({ agent_include_page })} />}
        />
        <Row
          label="Step limit"
          htmlFor="pref-agent-steps"
          hint="Most tool calls one message may make before the run is stopped."
          control={<Select id="pref-agent-steps" label="Step limit" value={String(prefs.agent_max_steps)} onChange={(v) => set({ agent_max_steps: Number(v) })} options={STEP_LIMITS.map((v) => ({ value: v, label: v }))} />}
        />
      </Group>

      <Group title="API keys" description="One key per provider, in your OS keychain. A key leaves this Mac only in calls to its own provider. The Agent panel (⌘J) can add these too.">
        {providers
          .filter((p) => p.needs_key)
          .map((p) => (
            <KeyRow key={p.id} provider={p} saved={keyed.includes(p.id)} />
          ))}
      </Group>
    </>
  );
}

function KeyRow({ provider, saved }: { provider: ProviderInfo; saved: boolean }) {
  const saveKey = useAgent((s) => s.saveKey);
  const verifyKey = useAgent((s) => s.verifyKey);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const verdict = await verifyKey(provider.id, key.trim());
      setStatus(verdict);
      if (verdict.ok) {
        await saveKey(provider.id, key.trim());
        setKey("");
        setEditing(false);
      }
    } catch (e) {
      setStatus({ ok: false, message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const hint = status ? <span className={status.ok ? "text-highlight" : "text-danger"}>{status.message}</span> : saved ? "Saved in your keychain." : provider.note;
  return (
    <Row
      label={provider.name}
      hint={hint}
      control={
        saved && !editing ? (
          <span className="flex items-center gap-2">
            <Button variant="quiet" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setStatus(null);
                void saveKey(provider.id, "");
              }}
            >
              Remove
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-2 pl-2.5 pr-1 focus-within:border-line-2">
              <Icon icon={KeyRound} size={12} className="shrink-0 text-ink-3" />
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && void submit()}
                placeholder={provider.key_hint || "API key"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${provider.name} API key`}
                className="w-[170px] bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3"
              />
            </span>
            <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void submit()}>
              {busy ? "Checking…" : "Save"}
            </Button>
            {editing && (
              <Button
                variant="quiet"
                onClick={() => {
                  setEditing(false);
                  setKey("");
                  setStatus(null);
                }}
              >
                Cancel
              </Button>
            )}
          </span>
        )
      }
    />
  );
}
