import source from "../../src-tauri/src/inject/permission-webui-probe.js?raw";
import { describe, expect, it, vi } from "vitest";

const run = new Function(`return (${source})`)();
const fixture = { origin: "https://chooser.invalid", siblingOrigin: "https://keep.invalid", protocol: "web+diveordinary", spec: "https://handler.invalid/?q=%s", protected: [{ protocol: "web+diveapp", spec: "https://app.invalid/?q=%s" }] };
function boundary(respond = true) {
  let protocols = [{ protocol: fixture.protocol, handlers: [{ protocol: fixture.protocol, spec: fixture.spec }] }, { protocol: fixture.protected[0]!.protocol, handlers: [fixture.protected[0]!] }];
  let grants = [{ origin: `${fixture.origin}/`, viewGrants: [{ filePath: "/fixture" }], editGrants: [] }, { origin: `${fixture.siblingOrigin}/`, viewGrants: [{ filePath: "/keep" }], editGrants: [] }];
  const listeners = new Map<number, (value: unknown) => void>();
  let uid = 0;
  const chrome = { send: vi.fn((name: string) => {
    if (name === "removeHandler") protocols = protocols.filter(p => p.protocol !== fixture.protocol);
    if (name === "revokeFileSystemGrants") grants = grants.filter(g => g.origin !== `${fixture.origin}/`);
    if (name === "observeProtocolHandlers" && respond) for (const cb of listeners.values()) cb(structuredClone(protocols));
  }) };
  const cr = { addWebUiListener: (_: string, cb: (value: unknown) => void) => { listeners.set(++uid, cb); return uid; }, removeWebUiListener: (id: number) => listeners.delete(id), sendWithPromise: vi.fn(async () => structuredClone(grants)) };
  return { cr, chrome, href: "chrome://settings/handlers", fixture, listeners };
}
describe("native permission WebUI probe", () => {
  it("queries effective services and removes only fixture grants once", async () => {
    const b = boundary();
    const result = await run(b);
    expect(result.ok).toBe(true);
    expect(b.chrome.send.mock.calls.filter(([name]) => name === "removeHandler")).toEqual([["removeHandler", [fixture.protocol, fixture.spec]]]);
    expect(b.chrome.send.mock.calls.filter(([name]) => name === "revokeFileSystemGrants")).toEqual([["revokeFileSystemGrants", [fixture.origin]]]);
    expect(b.listeners.size).toBe(0);
  });
  it("requires effective app identity and positive chooser fixtures before mutations", async () => {
    const b = boundary();
    await expect(run({ ...b, fixture: { ...fixture, protected: [{ ...fixture.protected[0], app_id: "expected-app" }] } })).rejects.toThrow("Protected handler");
    expect(b.chrome.send.mock.calls).toEqual([["observeProtocolHandlers"]]);
    const missing = boundary();
    missing.cr.sendWithPromise.mockResolvedValueOnce([]);
    await expect(run(missing)).rejects.toThrow("Chooser fixture");
    expect(missing.chrome.send.mock.calls).toEqual([["observeProtocolHandlers"]]);
  });
  it("refuses non-settings documents before any native messages", async () => {
    const b = boundary();
    await expect(run({ ...b, href: "https://attacker.invalid" })).rejects.toThrow();
    expect(b.chrome.send).not.toHaveBeenCalled();
  });
  it("removes a timed-out query listener and sends no mutations", async () => {
    vi.useFakeTimers();
    try {
      const b = boundary(false);
      const pending = expect(run(b)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      expect(b.listeners.size).toBe(0);
      expect(b.chrome.send.mock.calls).toEqual([["observeProtocolHandlers"]]);
    } finally { vi.useRealTimers(); }
  });
});
