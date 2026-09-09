import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { WebApp, WebAppProbe } from "../lib/ipc";
import { WEBAPPS_CHANGED, inScope, originOf, useWebApps } from "./webapps";

vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...original,
    ipc: { ...original.ipc, webappProbe: vi.fn(), webappInstall: vi.fn(), webappsList: vi.fn(), webappOpen: vi.fn(), webappUninstall: vi.fn() },
  };
});

const app: WebApp = {
  id: "https://mail.example/",
  name: "Mail",
  short_name: "Mail",
  start_url: "https://mail.example/inbox",
  scope: "https://mail.example/",
  display: "standalone",
  theme_color: null,
  background_color: null,
  icon_path: "/data/webapps/x/icon.png",
  manifest_url: "https://mail.example/manifest.json",
  created_at: "2026-09-10T00:00:00Z",
  last_opened_at: null,
  bounds: "",
};
const installable: WebAppProbe = {
  installable: true, reason: null, id: app.id, name: "Mail", short_name: "Mail", start_url: app.start_url, scope: app.scope,
  display: "standalone", theme_color: null, background_color: null, icon_url: "https://mail.example/icon.png", icon_size: 512,
  manifest_url: app.manifest_url, description: null, installed: null,
};
const initial = useWebApps.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useWebApps.setState(initial, true);
  vi.mocked(ipc.webappsList).mockResolvedValue([]);
});

describe("web apps store", () => {
  it("probes a tab once per URL and answers repeats from memory", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue(installable);
    const first = await useWebApps.getState().probe("t1", "https://mail.example/inbox");
    const again = await useWebApps.getState().probe("t1", "https://mail.example/inbox");
    expect(first).toEqual(installable);
    expect(again).toEqual(installable);
    expect(ipc.webappProbe).toHaveBeenCalledTimes(1);
    // A new URL in the same tab is a new question.
    await useWebApps.getState().probe("t1", "https://mail.example/settings");
    expect(ipc.webappProbe).toHaveBeenCalledTimes(2);
  });

  it("does not ask the page about non-http URLs", async () => {
    expect(await useWebApps.getState().probe("t1", "about:blank")).toBeNull();
    expect(await useWebApps.getState().probe("t1", "dive://settings")).toBeNull();
    expect(ipc.webappProbe).not.toHaveBeenCalled();
  });

  it("treats a failed probe as 'not installable' rather than an error", async () => {
    vi.mocked(ipc.webappProbe).mockRejectedValue(new Error("no devtools session"));
    expect(await useWebApps.getState().probe("t1", "https://x.example/")).toBeNull();
    expect(useWebApps.getState().error).toBeNull();
  });

  it("installing forgets the tab's probe, reloads the list and announces the change", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue(installable);
    vi.mocked(ipc.webappInstall).mockResolvedValue(app);
    vi.mocked(ipc.webappsList).mockResolvedValue([app]);
    const heard = vi.fn();
    window.addEventListener(WEBAPPS_CHANGED, heard);
    await useWebApps.getState().probe("t1", app.start_url);
    const installed = await useWebApps.getState().install("t1");
    expect(installed).toEqual(app);
    expect(useWebApps.getState().probes.t1).toBeUndefined();
    expect(useWebApps.getState().apps).toEqual([app]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(useWebApps.getState().installing).toBe(false);
    window.removeEventListener(WEBAPPS_CHANGED, heard);
  });

  it("surfaces an install failure and keeps the button usable", async () => {
    vi.mocked(ipc.webappInstall).mockRejectedValue(new Error("could not fetch the app icon"));
    expect(await useWebApps.getState().install("t1")).toBeNull();
    expect(useWebApps.getState().error).toMatch(/icon/);
    expect(useWebApps.getState().installing).toBe(false);
  });

  it("uninstalling drops every cached probe, since any page may now be installable again", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue({ ...installable, installed: app });
    vi.mocked(ipc.webappUninstall).mockResolvedValue(null);
    await useWebApps.getState().probe("t1", app.start_url);
    await useWebApps.getState().uninstall(app.id);
    expect(ipc.webappUninstall).toHaveBeenCalledWith(app.id);
    expect(useWebApps.getState().probes).toEqual({});
  });

  it("scope is a prefix match on the absolute URL", () => {
    expect(inScope("https://mail.example/inbox/1", "https://mail.example/")).toBe(true);
    expect(inScope("https://mail.example.evil/", "https://mail.example/")).toBe(false);
    expect(originOf("https://mail.example:8443/x")).toBe("mail.example:8443");
    expect(originOf("not a url")).toBe("not a url");
  });
});
