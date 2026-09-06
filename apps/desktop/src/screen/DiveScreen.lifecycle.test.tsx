import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiveScreen } from "./DiveScreen";
import { useEditor } from "./store";

const mocks = vi.hoisted(() => ({ info: vi.fn(), read: vi.fn(), write: vi.fn(), report: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { screenMediaInfo: mocks.info, screenProjectRead: mocks.read, screenProjectWrite: mocks.write } }));
vi.mock("../store/browser", () => ({ useBrowser: { setState: mocks.report } }));
vi.mock("../store/recording", () => ({ useRecording: (select: (s: { openSetup: () => void }) => unknown) => select({ openSetup: () => {} }) }));
vi.mock("../lib/mediaUrl", () => ({ captureMediaUrl: (path: string) => path }));
vi.mock("./Stage", () => ({ Stage: () => <div data-testid="preview">Preview</div> }));
vi.mock("./Timeline", () => ({ Timeline: () => null }));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("./ExportDialog", () => ({ ExportDialog: () => null }));

beforeEach(() => {
  mocks.info.mockImplementation(async (source: string) => ({ playable: `${source}.webm`, events: null, duration_ms: 5000, width: 640, height: 360 }));
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(null);
});
afterEach(async () => {
  cleanup();
  if (useEditor.getState().dirty) await useEditor.getState().save();
  useEditor.getState().close();
  vi.clearAllMocks();
});

it("keeps the preview and edits available after save failure and retries in place", async () => {
  render(<DiveScreen src="save-retry.mp4" tabId="editor" />);
  await screen.findByTestId("preview");
  act(() => useEditor.getState().update((editor) => ({ ...editor, padding: 49 })));
  mocks.write.mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByRole("button", { name: "Save Project" }));
  expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  expect(screen.getByTestId("preview")).toBeTruthy();
  expect(useEditor.getState().project?.editor.padding).toBe(49);
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(useEditor.getState().dirty).toBe(false);
  expect(useEditor.getState().project?.editor.padding).toBe(49);
});

it("does not let an old component cleanup close a replacement editor session", async () => {
  const view = render(<DiveScreen src="owner.mp4" tabId="old-editor" />);
  await screen.findByTestId("preview");
  await act(() => useEditor.getState().open("owner.mp4"));
  view.unmount();
  expect(useEditor.getState().project?.media.source).toBe("owner.mp4");
});
