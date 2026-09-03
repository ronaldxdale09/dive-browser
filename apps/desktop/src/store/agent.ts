import { create } from "zustand";
import { ipc } from "../lib/ipc";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  error?: string;
}

interface AgentState {
  keyPresent: boolean | null;
  messages: Message[];
  busy: boolean;
  checkKey: () => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  send: (text: string, tabId: string | null) => Promise<void>;
  clear: () => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

/** Apply one delta to the trailing assistant message. Pure for tests. */
export function applyDelta(messages: Message[], delta: { type: "text" | "done" | "error"; data: string }): Message[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  const patch: Partial<Message> =
    delta.type === "text"
      ? { content: last.content + delta.data }
      : delta.type === "done"
        ? { pending: false, ...(delta.data === "max_tokens" ? { error: "Reply was cut off at the length limit." } : delta.data === "refusal" ? { error: "The model declined this request." } : {}) }
        : { pending: false, error: delta.data };
  return [...messages.slice(0, -1), { ...last, ...patch }];
}

export const useAgent = create<AgentState>((set, get) => ({
  keyPresent: null,
  messages: [],
  busy: false,

  checkKey: async () => {
    try {
      set({ keyPresent: await ipc.agentKeyPresent() });
    } catch {
      set({ keyPresent: false });
    }
  },
  saveKey: async (key) => {
    await ipc.agentKeySet(key);
    set({ keyPresent: key.trim().length > 0 });
  },
  send: async (text, tabId) => {
    const prompt = text.trim();
    if (!prompt || get().busy) return;
    const history = get().messages.filter((m) => !m.error || m.role === "user");
    const user: Message = { id: nextId(), role: "user", content: prompt };
    const reply: Message = { id: nextId(), role: "assistant", content: "", pending: true };
    set({ messages: [...history, user, reply], busy: true });
    const turns = [...history, user].map((m) => ({ role: m.role, content: m.content }));
    try {
      await ipc.agentSend(turns, tabId, (d) => set((s) => ({ messages: applyDelta(s.messages, d) })));
    } catch (e) {
      set((s) => ({ messages: applyDelta(s.messages, { type: "error", data: e instanceof Error ? e.message : String(e) }) }));
    } finally {
      set((s) => ({ busy: false, messages: applyDelta(s.messages, { type: "done", data: "end_turn" }) }));
    }
  },
  clear: () => set({ messages: [] }),
}));
