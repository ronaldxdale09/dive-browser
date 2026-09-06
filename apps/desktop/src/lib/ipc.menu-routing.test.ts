import { beforeEach, expect, it, vi } from "vitest";
import type { EventCallback, EventTarget } from "@tauri-apps/api/event";

const bus = vi.hoisted(() => ({
  current: "chrome",
  next: 0,
  handlers: new Map<number, { name: string; target: EventTarget; callback: EventCallback<unknown> }>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: EventCallback<unknown>, options?: { target?: EventTarget }) => {
    const id = ++bus.next;
    bus.handlers.set(id, { name, callback, target: options?.target ?? { kind: "Any" } });
    return () => { bus.handlers.delete(id); };
  }),
}));
vi.mock("@tauri-apps/api/webview", async () => {
  const { listen } = await import("@tauri-apps/api/event");
  return { getCurrentWebview: () => {
    const label = bus.current;
    return { listen: (name: string, callback: EventCallback<unknown>) => listen(name, callback, { target: { kind: "Webview", label } }) };
  } };
});
import { events } from "./ipc";

// Pinned Tauri match_any_or_filter delivers Any listeners even for emit_to.
function emitTo(label: string, payload: string) {
  for (const [id, handler] of [...bus.handlers]) {
    if (handler.name === "menu-command" && (handler.target.kind === "Any" || (handler.target.kind === "Webview" && handler.target.label === label))) {
      handler.callback({ event: handler.name, id, payload });
    }
  }
}
beforeEach(() => { bus.current = "chrome"; bus.handlers.clear(); });

it("delivers New Window only to main chrome without echoing through detached windows", async () => {
  const main = vi.fn();
  const forwards = vi.fn();
  await events.menuCommand.listen(main);
  bus.current = "popout-a";
  const stopA = await events.menuCommand.listen(forwards);
  bus.current = "popout-b";
  await events.menuCommand.listen(forwards);
  emitTo("chrome", "window.new");
  expect(main).toHaveBeenCalledTimes(1);
  expect(forwards).not.toHaveBeenCalled();
  stopA();
  expect(bus.handlers.size).toBe(2);
});

it("keeps page commands in the addressed detached window", async () => {
  const main = vi.fn();
  const a = vi.fn();
  const b = vi.fn();
  await events.menuCommand.listen(main);
  bus.current = "popout-a";
  await events.menuCommand.listen(a);
  bus.current = "popout-b";
  await events.menuCommand.listen(b);
  emitTo("popout-a", "tab.close");
  expect(a).toHaveBeenCalledTimes(1);
  expect(main).not.toHaveBeenCalled();
  expect(b).not.toHaveBeenCalled();
});
