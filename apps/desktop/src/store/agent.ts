import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ChatDeltaOut, KeyCheck, ModelInfo, Provider, ProviderInfo, Usage } from "../lib/ipc";
import type { FailureKind } from "../generated/bindings";
import { usePrefs } from "./prefs";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

export interface Step {
  id: string;
  name: string;
  input: string;
  action: boolean;
  locator?: string | null;
  /** Why the step was put to the person before it ran, when it was. */
  caution?: string | null;
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
  /** What kind of failure `error` is, so the reply offers the fix that fits. */
  errorKind?: FailureKind;
  /**
   * What the run is doing that is not part of the reply, such as waiting out
   * a busy provider. Gone once the reply moves on, and never kept.
   */
  status?: string | undefined;
  steps?: Step[];
  /** The model's reasoning summary, when the provider streams one. */
  reasoning?: string;
  /** Token totals for this reply, across every tool round. */
  usage?: Usage;
  /** The user stopped this reply before the model finished. */
  stopped?: boolean;
  /** Pages that tried to give the agent instructions during this reply. */
  flagged?: string[];
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
  /**
   * Approve every action until the agent panel is closed. Not persisted, and
   * reset when the panel goes, as the button that turns it on promises.
   */
  sessionAutoApprove: boolean;
  /**
   * Run in a context of the agent's own: no cookies, nobody signed in, the
   * person's tabs untouched, and everything thrown away when the run ends.
   */
  cleanSession: boolean;
  /**
   * The tab `messages` belongs to. A conversation is about the page it was
   * had over, so each tab keeps its own and the browser hands it back when
   * you come back to that tab -- including after a restart.
   */
  tabId: string | null;
  /**
   * The tab the panel should show once the run in flight has finished. A run
   * owns the transcript while it streams, so a tab switch during one is
   * remembered here and carried out when the run ends.
   */
  wantedTab: string | null | undefined;
  /**
   * What is typed in the composer and not yet sent. Kept here rather than in
   * the composer so closing the panel -- Escape does it -- keeps it.
   */
  draft: string;

  init: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  saveKey: (provider: Provider, key: string) => Promise<void>;
  verifyKey: (provider: Provider, key: string | null) => Promise<KeyCheck>;
  loadModels: (provider: Provider, refresh?: boolean) => Promise<ModelInfo[]>;
  send: (text: string, tabId: string | null) => Promise<void>;
  /** Ask the last question again, without the reply that failed. */
  retry: (tabId: string | null) => Promise<void>;
  stop: () => Promise<void>;
  approve: (id: string, allow: boolean) => Promise<void>;
  setSessionAutoApprove: (v: boolean) => void;
  setCleanSession: (v: boolean) => void;
  loadFor: (tabId: string | null) => Promise<void>;
  clear: () => void;
  setDraft: (draft: string) => void;
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

/** What a step that never ran says once its reply is over. */
export const NOT_RUN = "not run";

/**
 * The message's steps once its reply is over: nothing left waiting for an
 * approval, and nothing left running. A step the run announced but never
 * carried out -- stopped, failed, or over the step limit -- would otherwise
 * spin for as long as the conversation is on screen.
 */
function settle(m: Message): Partial<Message> {
  if (!m.steps) return {};
  return {
    steps: m.steps.map((s) => {
      if (s.summary === undefined) return { ...s, awaiting: false, summary: NOT_RUN, error: true };
      return s.awaiting ? { ...s, awaiting: false } : s;
    }),
  };
}

/** Apply one delta to the trailing assistant message. Pure for tests. */
export function applyDelta(messages: Message[], delta: ChatDeltaOut): Message[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  let patch: Partial<Message>;
  switch (delta.type) {
    case "text":
      // The reply moving on answers whatever the status was waiting for.
      patch = { content: last.content + delta.data, status: undefined };
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
    case "flagged":
      // Worth seeing once. A page that repeats itself in three reads is one
      // page, and three chips saying so is noise.
      patch = (last.flagged ?? []).includes(delta.data) ? {} : { flagged: [...(last.flagged ?? []), delta.data] };
      break;
    case "usage":
      patch = { usage: delta.data };
      break;
    case "status":
      patch = { status: delta.data };
      break;
    case "done":
      patch = {
        pending: false,
        status: undefined,
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
      patch = { pending: false, status: undefined, error: delta.data.message, errorKind: delta.data.kind, ...settle(last) };
      break;
  }
  return [...messages.slice(0, -1), { ...last, ...patch }];
}

/** How long streamed deltas are held before they reach the store. */
export const STREAM_FLUSH_MS = 50;

/**
 * Deltas as they will be applied: adjacent text pieces become one, as do
 * adjacent reasoning pieces, so a flush of forty tokens is one append and
 * one message copy rather than forty. Everything else keeps its place, since
 * a tool call between two text pieces separates them. Pure for tests.
 */
export function coalesceDeltas(deltas: readonly ChatDeltaOut[]): ChatDeltaOut[] {
  const out: ChatDeltaOut[] = [];
  for (const delta of deltas) {
    const last = out.at(-1);
    if (last && (delta.type === "text" || delta.type === "reasoning") && last.type === delta.type) out[out.length - 1] = { type: delta.type, data: last.data + delta.data };
    else out.push(delta);
  }
  return out;
}

/**
 * Hand deltas to the store a few times a second rather than per token.
 *
 * A reply streams hundreds of tokens a second, and a store write for each
 * re-rendered the thread and re-parsed the Markdown that often. Text and
 * reasoning wait for the timer; anything that changes what the person can
 * do -- a tool call, an approval request, the end of the reply -- goes
 * through at once, carrying whatever text was waiting so order holds.
 */
function batchDeltas(apply: (deltas: ChatDeltaOut[]) => void) {
  let buffered: ChatDeltaOut[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buffered.length === 0) return;
    const deltas = buffered;
    buffered = [];
    apply(coalesceDeltas(deltas));
  };
  const push = (delta: ChatDeltaOut) => {
    buffered.push(delta);
    if (delta.type === "text" || delta.type === "reasoning") timer ??= setTimeout(flush, STREAM_FLUSH_MS);
    else flush();
  };
  return { push, flush };
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

/**
 * A conversation as it is kept: the transient parts of a message belong to
 * the run that produced them, not to the record of it.
 *
 * `pending` and `awaiting` describe something in flight; restoring them would
 * show a thinking indicator for a run that ended days ago, and a step waiting
 * for an approval nobody can give.
 */
export function settledForStorage(messages: Message[]): Message[] {
  const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
    const copy = { ...value };
    delete copy[key];
    return copy;
  };
  return messages
    .filter((m) => m.content || m.error || (m.steps && m.steps.length > 0))
    .map((m) => {
      const settled = without(without(m, "pending"), "status");
      return m.steps ? { ...settled, steps: m.steps.map((s) => without(s, "awaiting")) } : settled;
    });
}

/** What a conversation is called in a list of them: what was first asked. */
export function threadTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Keep the conversation for the tab it belongs to, if there is anything to
 * keep. A save that fails is said out loud: swallowing it meant a restart
 * quietly brought back an older conversation than the one on screen.
 */
function persist(state: { tabId: string | null; messages: Message[] }): void {
  const { tabId, messages } = state;
  if (!tabId) return;
  const keep = settledForStorage(messages);
  if (keep.length === 0) return;
  void ipc.agentThreadSave(tabId, threadTitle(keep), JSON.stringify(keep)).catch((e: unknown) => {
    useBrowser.getState().notify(`The agent conversation could not be saved: ${errorMessage(e)}`, 6000);
  });
}

/**
 * The turns the model is sent: what was said, minus replies that failed and
 * replies that were stopped before they said anything. An assistant turn with
 * no text is refused by Anthropic, so asking again after Stop failed.
 */
export function turnsFor(messages: readonly Message[]): { role: Message["role"]; content: string }[] {
  return messages.filter((m) => m.role === "user" || (!m.error && m.content.trim() !== "")).map((m) => ({ role: m.role, content: m.content }));
}

/** Messages read back from the host, or none if they are not what we wrote. */
export function parseThread(messages: string): Message[] {
  try {
    const parsed: unknown = JSON.parse(messages);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
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
  cleanSession: false,
  tabId: null,
  wantedTab: undefined,
  draft: "",

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
    // Taken before anything is awaited, so a second send cannot slip in
    // while the right conversation is being read back.
    set({ busy: true });
    // The panel may still be showing another tab's conversation -- the one a
    // run just finished in, or none yet because the dock has not mounted
    // (Explain in the Network panel sends before it opens). The question
    // belongs to `tabId`'s conversation, and it is saved under that tab.
    if (tabId !== get().tabId) await switchTo(tabId);
    const history = get().messages.filter((m) => !m.error || m.role === "user");
    const user: Message = { id: nextId(), role: "user", content: prompt };
    const reply: Message = { id: nextId(), role: "assistant", content: "", pending: true };
    const runId = newRunId();
    set({ messages: [...history, user, reply], busy: true, runId, tabId });
    const turns = turnsFor([...history, user]);
    const prefs = usePrefs.getState().prefs;
    const cleanSession = get().cleanSession;
    const options = {
      // A clean run has no page of the person's to send.
      include_page: prefs.agent_include_page && !cleanSession,
      auto_approve: get().sessionAutoApprove,
      clean_session: cleanSession,
    };
    const stream = batchDeltas((deltas) => set((s) => ({ messages: deltas.reduce(applyDelta, s.messages) })));
    try {
      await ipc.agentSend(runId, turns, tabId, options, stream.push);
    } catch (e) {
      stream.push({ type: "error", data: { message: errorMessage(e), kind: "other" } });
    } finally {
      // Nothing may be left waiting once the reply is over.
      stream.flush();
      set((s) => ({ busy: false, runId: null, messages: applyDelta(s.messages, { type: "done", data: "end_turn" }) }));
      persist(get());
      // The person moved to another tab while this ran; now the panel can
      // follow them.
      const wanted = get().wantedTab;
      if (wanted !== undefined) {
        set({ wantedTab: undefined });
        if (wanted !== get().tabId) void get().loadFor(wanted);
      }
    }
  },
  retry: async (tabId) => {
    if (get().busy) return;
    const messages = get().messages;
    const failed = messages.at(-1);
    if (!failed || failed.role !== "assistant" || !failed.error) return;
    let question = messages.length - 1;
    while (question >= 0 && messages[question]?.role !== "user") question -= 1;
    const asked = messages[question];
    if (!asked) return;
    // The failed reply and the question it answered both go; the question
    // comes back as the new turn, so it is asked once, not twice.
    set({ messages: messages.slice(0, question) });
    await get().send(asked.content, tabId);
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
  setCleanSession: (cleanSession) => set({ cleanSession }),
  loadFor: async (tabId) => {
    const { tabId: current, busy } = get();
    // A run in flight owns the panel until it finishes: swapping the
    // transcript underneath it would strand the reply being streamed. The
    // switch is remembered and made when the run ends.
    if (busy) {
      set({ wantedTab: tabId === current ? undefined : tabId });
      return;
    }
    if (tabId === current) return;
    await switchTo(tabId);
  },
  clear: () => {
    const { tabId } = get();
    set({ messages: [] });
    if (tabId) void ipc.agentThreadClear(tabId).catch(() => undefined);
  },
  setDraft: (draft) => set({ draft }),
}));

/**
 * Show `tabId`'s conversation: write back the one on screen, then read the
 * tab's own. Callers make sure no run is streaming into the one on screen.
 */
async function switchTo(tabId: string | null): Promise<void> {
  const { getState, setState } = useAgent;
  persist(getState());
  setState({ tabId, messages: [] });
  if (!tabId) return;
  try {
    const thread = await ipc.agentThreadLoad(tabId);
    // The tab may have changed again while the host was answering.
    if (getState().tabId !== tabId) return;
    setState({ messages: thread ? parseThread(thread.messages) : [] });
  } catch {
    // A conversation we cannot read back is not worth an error in the
    // panel; the tab simply starts a new one.
  }
}
