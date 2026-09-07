import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { SubtitleModel, SubtitleModelProgress } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { bootSubtitles, resetSubtitlesListener, useSubtitles } from "../store/subtitles";
import { Subtitles } from "./Subtitles";

const MODELS: SubtitleModel[] = [
  { id: "base", label: "Base", detail: "Fastest", size_mb: 142, downloaded: false },
  { id: "small", label: "Small", detail: "Balanced", size_mb: 466, downloaded: true },
  { id: "medium", label: "Medium", detail: "Most accurate", size_mb: 1500, downloaded: false },
];

const subtitlesInitial = useSubtitles.getState();

function openDialog() {
  useBrowser.setState({
    activeTab: "t1",
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, extensions: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: true },
  });
}

/** Capture the progress handler bootSubtitles registers, to fire an event. */
function captureProgress(): { fire: (p: SubtitleModelProgress) => void } {
  let cb: ((e: { payload: SubtitleModelProgress }) => void) | undefined;
  vi.spyOn(events.subtitleModelProgress, "listen").mockImplementation((h) => {
    cb = h as typeof cb;
    return Promise.resolve(() => undefined);
  });
  vi.spyOn(events.subtitleState, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.subtitleCue, "listen").mockResolvedValue(() => undefined);
  return { fire: (p) => cb?.({ payload: p }) };
}

beforeEach(() => {
  resetSubtitlesListener();
  useSubtitles.setState(subtitlesInitial, true);
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "subtitleModels").mockResolvedValue(MODELS);
  vi.spyOn(ipc, "subtitleRunning").mockResolvedValue(false);
  vi.spyOn(ipc, "subtitleModelDownload").mockResolvedValue(null);
  vi.spyOn(ipc, "subtitleStart").mockResolvedValue(null);
  vi.spyOn(ipc, "subtitleStop").mockResolvedValue(undefined);
  openDialog();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Subtitles dialog", () => {
  it("keeps a failed start visible and allows retry", async () => {
    vi.mocked(ipc.subtitleStart).mockRejectedValueOnce(new Error("No audio track"));
    useSubtitles.setState({ model: "small" });
    render(<Subtitles />);
    await screen.findByText("Small");
    fireEvent.click(screen.getByRole("button", { name: "Start subtitles" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "No audio track");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start subtitles" })).toHaveProperty("disabled", false);
  });
  it("closes on Escape while Start is still disabled", async () => {
    vi.mocked(ipc.subtitleModels).mockResolvedValue(MODELS.map((m) => ({ ...m, downloaded: false })));
    useSubtitles.setState({ model: "base" });
    render(<Subtitles />);
    await screen.findByText("Base");
    expect(screen.getByRole("button", { name: "Start subtitles" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(document.activeElement ?? screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.subtitles).toBe(false));
  });

  it("lists the models with sizes and download state", async () => {
    render(<Subtitles />);
    expect(await screen.findByText("Base")).toBeTruthy();
    expect(screen.getByText("Small")).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
    // Small is already on disk.
    expect(screen.getAllByText("Downloaded").length).toBe(1);
    expect(screen.getByRole("button", { name: /Download \(142 MB\)/ })).toBeTruthy();
  });

  it("downloads a model and shows its progress", async () => {
    const progress = captureProgress();
    await bootSubtitles();
    render(<Subtitles />);
    const button = await screen.findByRole("button", { name: /Download \(142 MB\)/ });
    fireEvent.click(button);
    expect(ipc.subtitleModelDownload).toHaveBeenCalledWith("base");

    progress.fire({ id: "base", received: 71_000_000, total: 142_000_000, done: false, error: null });
    expect(await screen.findByText("71.0 MB / 142.0 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /Downloading Base/ })).toBeTruthy();
  });

  it("changes the language", async () => {
    render(<Subtitles />);
    await screen.findByText("Base");
    fireEvent.change(screen.getByLabelText("Subtitle language"), { target: { value: "ja" } });
    expect(useSubtitles.getState().language).toBe("ja");
  });

  it("toggles translate to English", async () => {
    render(<Subtitles />);
    await screen.findByText("Base");
    fireEvent.click(screen.getByRole("switch", { name: "Translate to English" }));
    expect(useSubtitles.getState().translate).toBe(true);
  });

  it("starts with the chosen model, language and translate, then closes", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: true, media, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
    render(<Subtitles />);
    await screen.findByText("Small");
    // Choose the downloaded model and set options.
    fireEvent.click(screen.getByRole("radio", { name: "Use Small" }));
    fireEvent.change(screen.getByLabelText("Subtitle language"), { target: { value: "ja" } });
    fireEvent.click(screen.getByRole("switch", { name: "Translate to English" }));

    fireEvent.click(screen.getByRole("button", { name: "Start subtitles" }));
    await waitFor(() => expect(ipc.subtitleStart).toHaveBeenCalledWith("t1", "small", "ja", true));
    await waitFor(() => expect(useBrowser.getState().open.subtitles).toBe(false));
    vi.unstubAllGlobals();
  });

  it("selects a downloaded model on load and disables Start for one that is not", async () => {
    render(<Subtitles />);
    await screen.findByText("Base");
    // The default "base" is not downloaded, so the list settles on the model
    // that is, and Start is ready at once.
    await waitFor(() => expect((screen.getByRole("button", { name: "Start subtitles" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "Use Base" }));
    expect((screen.getByRole("button", { name: "Start subtitles" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Use Small" }));
    expect((screen.getByRole("button", { name: "Start subtitles" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops a running session", async () => {
    // The mount check reports it is already running on this tab.
    vi.mocked(ipc.subtitleRunning).mockResolvedValue(true);
    useSubtitles.setState({ lastCue: "Hello" });
    render(<Subtitles />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop subtitles" })).toBeTruthy());
    expect(screen.getByText("Hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop subtitles" }));
    await waitFor(() => expect(ipc.subtitleStop).toHaveBeenCalledWith("t1"));
  });

  it("shows an error", async () => {
    render(<Subtitles />);
    await screen.findByText("Base");
    // Set after the model load, whose success resets the error.
    useSubtitles.setState({ error: "no audio" });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "no audio");
  });
});
