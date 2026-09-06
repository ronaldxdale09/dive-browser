import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover, useCoversContent } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Content, describePermission } from "./Content";

// The welcome screen, the device simulator and its picker have tests of
// their own and lean on browser APIs jsdom lacks.
vi.mock("./Welcome", () => ({ Welcome: () => null }));
vi.mock("./simulator/DeviceStage", () => ({ DeviceStage: () => null }));
vi.mock("./simulator/DevicePicker", () => ({ DevicePicker: () => null }));

const tab: Tab = {
  id: "t1",
  workspace_id: "w1",
  tier: "today",
  url: "http://localhost:3000/",
  title: "",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, activeWorkspace: tab.workspace_id, navError: {}, crashedTabs: {}, loading: {}, permissionRequests: {} });
  vi.spyOn(ipc, "permissionReply").mockResolvedValue(null);
  vi.spyOn(ipc, "setContentBounds").mockResolvedValue(null);
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "appInfo").mockRejectedValue(new Error("no app"));
  vi.spyOn(ipc, "tabReload").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("Content error panel", () => {
  it("shows a frozen copy of the real page while chrome covers the native view", async () => {
    vi.mocked(ipc.prepareContentCover).mockResolvedValue([{ tab_id: "t1", data_url: "data:image/jpeg;base64,real-page" }]);
    function DialogCover() {
      useCoversContent(true);
      return null;
    }

    const { container } = render(
      <>
        <Content />
        <DialogCover />
      </>,
    );

    await waitFor(() => expect(container.querySelector('img[src="data:image/jpeg;base64,real-page"]')).not.toBeNull());
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
    expect(container.textContent).not.toContain("Loading page");
  });

  it("shows nothing over the page while the tab is healthy", () => {
    render(<Content />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
  });

  it("explains a refused connection, covers the page, and retries with a reload", async () => {
    useBrowser.setState({ navError: { t1: { url: "http://localhost:3000/", error: "net::ERR_CONNECTION_REFUSED" } } });
    render(<Content />);

    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("Connection refused");
    expect(panel.textContent).toContain("check it is running on port 3000");
    expect(panel.textContent).toContain("http://localhost:3000/");
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ipc.tabReload).toHaveBeenCalledWith("t1");
  });

  it("uncovers the page once the error clears", async () => {
    useBrowser.setState({ navError: { t1: { url: "https://nope.test/", error: "net::ERR_NAME_NOT_RESOLVED" } } });
    render(<Content />);
    expect(screen.getByRole("alert").textContent).toContain("This site can't be reached");
    expect(screen.getByRole("alert").textContent).toContain("DNS lookup failed");

    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));
    act(() => useBrowser.getState().applyLoad({ tab_id: "t1", phase: "started", url: "https://nope.test/", error: null }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("only speaks for the active tab", () => {
    useBrowser.setState({ navError: { other: { url: "https://x", error: "net::ERR_INTERNET_DISCONNECTED" } } });
    render(<Content />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Content crash banner", () => {
  it("reports a recovery in progress above the page without covering it", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 2, recovering: true } } });
    const { container } = render(<Content />);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("renderer crashed — reloading (attempt 2)");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    // The banner is a sibling above the row holding the page, so the page's
    // reported rectangle starts below it rather than underneath it.
    const root = container.firstElementChild!;
    expect(root.firstElementChild).toBe(banner);
    expect(banner.contains(root.lastElementChild)).toBe(false);
  });

  it("offers a reload once Dive has given up", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 3, recovering: false } } });
    render(<Content />);
    expect(screen.getByRole("status").textContent).toContain("stopped reloading");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(ipc.tabReload).toHaveBeenCalledWith("t1");
  });

  it("goes away when the tab has a document again", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 1, recovering: true } } });
    render(<Content />);
    act(() => useBrowser.getState().applyLoad({ tab_id: "t1", phase: "stopped", url: null, error: null }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Content permission banner", () => {
  const camera = { page_lifetime:true, request_id: "r1", tab_id: "t1", origin: "https://meet.test", kinds: ["camera"], scope: {profile_id:"p1",container_id:"c1"} };

  it("names what the page wants in plain words", () => {
    expect(describePermission("camera")).toBe("use your camera");
    expect(describePermission("microphone")).toBe("use your microphone");
    expect(describePermission("geolocation")).toBe("know your location");
    expect(describePermission("notifications")).toBe("show notifications");
    expect(describePermission("clipboard_read")).toBe("read your clipboard");
    expect(describePermission("display_capture")).toBe("capture your screen");
    expect(describePermission("midi_sysex")).toBe("use midi sysex");
  });

  it("asks above the page without covering it, and blocks", async () => {
    useBrowser.setState({ permissionRequests: { t1: [camera] } });
    const { container } = render(<Content />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("https://meet.test");
    expect(banner.textContent).toContain("wants to use your camera");
    expect(contentCoverDepth()).toBe(0);
    expect(container.firstElementChild!.firstElementChild).toBe(banner);

    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(ipc.permissionReply).toHaveBeenCalledWith("t1", "r1", "deny", "remember");
    await waitFor(() => expect(useBrowser.getState().permissionRequests).toEqual({}));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("resumes the original request with a page-only choice without reloading", async () => {
    useBrowser.setState({ permissionRequests: { t1: [camera] } });
    render(<Content />);
    fireEvent.change(screen.getByRole("combobox", {name:"Permission duration"}), {target:{value:"page"}});
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(ipc.permissionReply).toHaveBeenCalledWith("t1", "r1", "allow", "page");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(ipc.tabReload).not.toHaveBeenCalled();
  });

  it("keeps a failed reply visible and allows retry instead of claiming success", async () => {
    vi.mocked(ipc.permissionReply).mockRejectedValueOnce(new Error("write failed"));
    useBrowser.setState({permissionRequests:{t1:[camera]}});
    render(<Content />);
    fireEvent.click(screen.getByRole("button",{name:"Allow"}));
    await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("write failed"));
    expect(useBrowser.getState().permissionRequests.t1).toEqual([camera]);
    expect(screen.queryByText(/reload to apply/)).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Allow"}));
    await waitFor(()=>expect(useBrowser.getState().permissionRequests).toEqual({}));
  });

  it("does not promise page-only lifetime for a persistent native prompt", () => {
    useBrowser.setState({permissionRequests:{t1:[{...camera,page_lifetime:false,kinds:["notifications"]}]}});
    render(<Content />);
    expect(screen.queryByRole("option",{name:"Until this page navigates or closes"})).toBeNull();
    expect(screen.getByRole("combobox", { name: "Permission duration" }).getAttribute("title")).toMatch(/This permission is remembered/);
  });

  it("queues a second request behind the first and only speaks for the active tab", async () => {
    useBrowser.setState({ permissionRequests: { t1: [camera, { ...camera, request_id:"r2", kinds:["microphone"] }], other: [{ ...camera, tab_id:"other", request_id:"r3", origin:"https://x", kinds:["geolocation"] }] } });
    render(<Content />);
    expect(screen.getByRole("status").textContent).toContain("camera");
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("microphone"));
    expect(screen.getByRole("status").textContent).not.toContain("location");
  });
});
