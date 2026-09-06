import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ChatDeltaOut, KeyCheck, ModelInfo, Provider, ProviderInfo, Usage } from "../lib/ipc";
import { usePrefs } from "./prefs";
import { errorMessage } from "../lib/errors";

export interface Step {
  id: string;
  name: string;
  input: string;
  action: boolean;
  locator?: string | null;
  summary?: string;
  error?: boolean;
  /** Waiting for the user's Allow / Deny. */
  awaiting?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  error?: string;
  steps?: Step[];
  /** The model's reasoning summary, when the provider streams one. */
  reasoning?: string;
  /** Token totals for this reply, across every tool round. */
  usage?: Usage;
  /** The user stopped this reply before the model finished. */
  stopped?: boolean;
}

interface AgentState {
  /** The provider catalog, from the host. */
  providers: ProviderInfo[];
  /** Providers with a key in the keychain. */
  keyed: Provider[];
  /** `null` until the first `init` has answered. */
  loaded: boolean;
  initError: string | null;
  /** Model listings by provider id. */
  models: Record<string, ModelInfo[]>;
  modelsLoading: string | null;
  modelsError: string | null;
  messages: Message[];
  busy: boolean;
  /** Id of the run in flight, for `stop`. */
  runId: string | null;
  /** Approve every action for the rest of this session. Not persisted. */
  sessionAutoApprove: boolean;

  init: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  saveKey: (provider: Provider, key: string) => Promise<void>;
  verifyKey: (provider: Provider, key: string | null) => Promise<KeyCheck>;
  loadModels: (provider: Provider, refresh?: boolean) => Promise<ModelInfo[]>;
  send: (text: string, tabId: string | null) => Promise<void>;
  stop: () => Promise<void>;
  approve: (id: string, allow: boolean) => Promise<void>;
  setSessionAutoApprove: (v: boolean) => void;
  clear: () => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;
const newRunId = () => `run-${Date.now().toString(36)}-${(++seq).toString(36)}`;
let initializing: Promise<void> | null = null;
let keyGeneration = 0;

/** A stalled host credential request must not keep the panel loading forever. */
function initializationDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Agent initialization timed out. Try again.")), 10_000);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/** The message's steps with no approval left pending, or nothing to patch. */
function settle(m: Message): Partial<Message> {
  return m.steps ? { steps: m.steps.map((s) => (s.awaiting ? { ...s, awaiting: false } : s)) } : {};
}

/** Apply one delta to the trailing assistant message. Pure for tests. */
export function applyDelta(messages: Message[], delta: ChatDeltaOut): Message[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  let patch: Partial<Message>;
  switch (delta.type) {
    case "text":
      patch = { content: last.content + delta.data };
      break;
    case "reasoning":
      patch = { reasoning: (last.reasoning ?? "") + delta.data };
      break;
    case "tool_call":
      patch = { steps: [...(last.steps ?? []), { ...delta.data }] };
      break;
    case "needs_approval":
      patch = { steps: (last.steps ?? []).map((s) => (s.id === delta.data.id ? { ...s, awaiting: true } : s)) };
      break;
    case "tool_done":
      patch = { steps: (last.steps ?? []).map((s) => (s.id === delta.data.id ? { ...s, summary: delta.data.summary, error: delta.data.error, awaiting: false } : s)) };
      break;
    case "usage":
      patch = { usage: delta.data };
      break;
    case "done":
      patch = {
        pending: false,
        // Every step still waiting is moot once the reply is over.
        ...settle(last),
        ...(delta.data === "stopped"
          ? { stopped: true }
          : delta.data === "max_tokens"
            ? { error: "Reply was cut off at the length limit." }
            : delta.data === "refusal"
              ? { error: "The model declined this request." }
              : {}),
      };
      break;
    case "error":
      patch = { pending: false, error: delta.data, ...settle(last) };
      break;
  }
  return [...messages.slice(0, -1), { ...last, ...patch }];
}

/** The provider currently selected in preferences, with its catalog row. */
export function currentProvider(providers: ProviderInfo[]): ProviderInfo | undefined {
  const id = usePrefs.getState().prefs.agent_provider;
  return providers.find((p) => p.id === id);
}

/** Whether `provider` can be used right now: it has a key, or needs none. */
export function isReady(provider: ProviderInfo | undefined, keyed: Provider[]): boolean {
  if (!provider) return false;
  return !provider.needs_key || keyed.includes(provider.id);
}

export const useAgent = create<AgentState>((set, get) => ({
  providers: [],
  keyed: [],
  loaded: false,
  initError: null,
  models: {},
  modelsLoading: null,
  modelsError: null,
  messages: [],
  busy: false,
  runId: null,
  sessionAutoApprove: false,

  init: () => {
    if (initializing) return initializing;
    const generation = ++keyGeneration;
    set({ loaded: false, initError: null });
    initializing = initializationDeadline(Promise.all([ipc.agentProviders(), ipc.agentKeys()]))
      .then(([providers, keyed]) => set({ providers, ...(generation === keyGeneration ? { keyed } : {}), loaded: true }))
      .catch((error: unknown) => set({ loaded: true, initError: errorMessage(error) }))
      .finally(() => { initializing = null; });
    return initializing;
  },
  refreshKeys: async () => {
    const generation = ++keyGeneration;
    try {
      const keyed = await initializationDeadline(ipc.agentKeys());
      if (generation === keyGeneration) set({ keyed });
    } catch {
      // keychain unavailable; keep what we had
    }
  },
  saveKey: async (provider, key) => {
    await ipc.agentKeySet(provider, key);
    // A new key may list different models than the old one did.
    set((s) => {
      const models = { ...s.models };
      delete models[provider];
      return { models };
    });
    await get().refreshKeys();
  },
  verifyKey: (provider, key) => ipc.agentKeyVerify(provider, key),
  loadModels: async (provider, refresh = false) => {
    const cached = get().models[provider];
    if (cached && !refresh) return cached;
    set({ modelsLoading: provider, modelsError: null });
    try {
      const list = await ipc.agentModels(provider, refresh);
      set((s) => ({ models: { ...s.models, [provider]: list }, modelsLoading: null }));
      return list;
    } catch (e) {
      set({ modelsLoading: null, modelsError: errorMessage(e) });
      return [];
    }
  },
  send: async (text, tabId) => {
    const prompt = text.trim();
    if (!prompt || get().busy) return;
    const history = get().messages.filter((m) => !m.error || m.role === "user");
    const user: Message = { id: nextId(), role: "user", content: prompt };
    const reply: Message = { id: nextId(), role: "assistant", content: "", pending: true };
    const runId = newRunId();
    set({ messages: [...history, user, reply], busy: true, runId });
    const turns = [...history, user].map((m) => ({ role: m.role, content: m.content }));
    const prefs = usePrefs.getState().prefs;
    const options = { include_page: prefs.agent_include_page, auto_approve: get().sessionAutoApprove };
    try {
      await ipc.agentSend(runId, turns, tabId, options, (d) => set((s) => ({ messages: applyDelta(s.messages, d) })));
    } catch (e) {
      set((s) => ({ messages: applyDelta(s.messages, { type: "error", data: errorMessage(e) }) }));
    } finally {
      set((s) => ({ busy: false, runId: null, messages: applyDelta(s.messages, { type: "done", data: "end_turn" }) }));
    }
  },
  stop: async () => {
    const { runId } = get();
    if (!runId) return;
    await ipc.agentStop(runId).catch(() => undefined);
  },
  approve: async (id, allow) => {
    set((s) => ({ messages: s.messages.map((m) => (m.steps ? { ...m, steps: m.steps.map((st) => (st.id === id ? { ...st, awaiting: false } : st)) } : m)) }));
    await ipc.agentApprove(id, allow).catch(() => undefined);
  },
  setSessionAutoApprove: (sessionAutoApprove) => set({ sessionAutoApprove }),
  clear: () => set({ messages: [] }),
}));
