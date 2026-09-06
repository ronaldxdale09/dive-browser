import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenUrl } from "../components/internal/InternalPage";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useImportVideo } from "./importVideo";

const initial = useBrowser.getState();
beforeEach(() => {
  useBrowser.setState({ ...initial, activeWorkspace: "w1", error: null }, true);
  vi.spyOn(ipc, "tabOpen").mockResolvedValue({ id: "t2", workspace_id: "w1", tier: "today", url: "dive://screen", title: "", favicon: null, position: 1, state: "active", last_active_at: "2026-09-04T00:00:00Z" });
});
afterEach(() => {
  useBrowser.setState(initial, true);
  useImportVideo.setState({ busy: false });
  vi.restoreAllMocks();
});

describe("importVideo", () => {
  it("imports, reports busy meanwhile, then opens the editor tab", async () => {
    let finish!: (path: string) => void;
    vi.spyOn(ipc, "screenImportVideo").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const opened = vi.fn();
    const pending = useImportVideo.getState().open(opened);
    expect(useImportVideo.getState().busy).toBe(true);
    expect(await useImportVideo.getState().open()).toBeNull();
    expect(ipc.screenImportVideo).toHaveBeenCalledOnce();
    finish("/captures/clip.mp4");
    expect(await pending).toBe("/captures/clip.mp4");
    expect(opened).toHaveBeenCalledOnce();
    expect(ipc.tabOpen).toHaveBeenCalledWith("w1", screenUrl("/captures/clip.mp4"));
    expect(useImportVideo.getState().busy).toBe(false);
  });

  it("opens nothing when the dialog is dismissed", async () => {
    vi.spyOn(ipc, "screenImportVideo").mockResolvedValue(null);
    expect(await useImportVideo.getState().open()).toBeNull();
    expect(ipc.tabOpen).not.toHaveBeenCalled();
    expect(useBrowser.getState().error).toBeNull();
  });

  it("surfaces an import failure through the browser error and clears busy", async () => {
    vi.spyOn(ipc, "screenImportVideo").mockRejectedValue(new Error("ffprobe could not read the recording"));
    expect(await useImportVideo.getState().open()).toBeNull();
    expect(useBrowser.getState().error).toContain("ffprobe could not read the recording");
    expect(useImportVideo.getState().busy).toBe(false);
    expect(ipc.tabOpen).not.toHaveBeenCalled();
  });
});
