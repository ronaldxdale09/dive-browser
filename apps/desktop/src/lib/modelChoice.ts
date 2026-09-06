import type { ModelInfo } from "./ipc";

/**
 * The model to use once a provider's list is known: the preferred one if it
 * is on the list, otherwise the first chat-capable model that is. Embedding
 * models cannot hold a conversation, so they are passed over.
 */
export function pickInstalledModel(list: ModelInfo[], preferred: string): string | null {
  if (list.length === 0) return null;
  if (list.some((m) => m.id === preferred)) return preferred;
  const chat = list.find((m) => !/embed|bge|e5-|minilm|rerank/i.test(m.id));
  return (chat ?? list[0])?.id ?? null;
}
