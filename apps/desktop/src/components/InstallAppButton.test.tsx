import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { Tab, WebApp, WebAppProbe } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useWebApps } from "../store/webapps";
import { InstallAppButton } from "./InstallAppButton";

vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, webappProbe: vi.fn(), webappInstall: vi.fn(), webappsList: vi.fn(), webappOpen: vi.fn() } };
});

const tab: Tab = { id: "a", workspace_id: "w", tier: "today", url: "https://mail.example/inbox", title: "Mail", favicon: null, position: 0, state: "active", last_active_at: "2026-09-10T00:00:00Z" };
const app: WebApp = { id: "https://mail.example/", name: "Mail by Example", short_name: "Mail", start_url: tab.url, scope: "https://mail.example/", display: "standalone", theme_color: null, background_color: null, icon_path: "", manifest_url: "https://mail.example/m.json", created_at: "", last_opened_at: null, bounds: "" };
const installable: WebAppProbe = { installable: true, reason: null, id: app.id, name: app.name, short_name: "Mail", start_url: tab.url, scope: app.scope, display: "standalone", theme_color: null, background_color: null, icon_url: "https://mail.example/icon.png", icon_size: 512, manifest_url: app.manifest_url, description: "Your inbox", installed: null };

const initialBrowser = useBrowser.getState();
const initialWebApps = useWebApps.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useBrowser.setState({ ...initialBrowser, tabs: [tab], activeTab: tab.id, loading: {} }, true);
  useWebApps.setState(initialWebApps, true);
  vi.mocked(ipc.webappsList).mockResolvedValue([]);
});
afterEach(cleanup);

describe("InstallAppButton", () => {
  it("shows nothing while the page is loading or when it is not installable", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue({ ...installable, installable: false, reason: "no manifest" });
    useBrowser.setState({ loading: { a: true } });
    render(<InstallAppButton />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(ipc.webappProbe).not.toHaveBeenCalled();
    act(() => useBrowser.setState({ loading: { a: false } }));
    await waitFor(() => expect(ipc.webappProbe).toHaveBeenCalledWith("a"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers to install an installable page, and the dialog names it", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue(installable);
    render(<InstallAppButton />);
    const button = await screen.findByRole("button", { name: "Install Mail" });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Install app" });
    expect(dialog.textContent).toContain("Mail by Example");
    expect(dialog.textContent).toContain("mail.example");
    expect(dialog.textContent).toContain("Your inbox");
  });

  it("installs from the dialog and closes it on success", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue(installable);
    vi.mocked(ipc.webappInstall).mockResolvedValue(app);
    render(<InstallAppButton />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Mail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(ipc.webappInstall).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Install app" })).toBeNull());
  });

  it("offers to open the app instead once the page is covered by an installed one", async () => {
    vi.mocked(ipc.webappProbe).mockResolvedValue({ ...installable, installed: app });
    vi.mocked(ipc.webappOpen).mockResolvedValue("t2");
    render(<InstallAppButton />);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Mail" }));
    await waitFor(() => expect(ipc.webappOpen).toHaveBeenCalledWith(app.id));
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  });
});
