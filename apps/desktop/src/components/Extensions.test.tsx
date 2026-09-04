import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { ExtensionInfo, ExtensionList } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Extensions } from "./Extensions";

const initial = useBrowser.getState();
const fixture: ExtensionInfo = {
  id: "fixture-id",
  name: "Fixture helper",
  version: "1.2.3",
  manifest_version: 3,
  path: "/tmp/fixture-extension",
  enabled: true,
  permissions: ["storage", "https://example.com/*"],
  warnings: ["A compatibility warning."],
};
const listed = (items: ExtensionInfo[] = [fixture], restart_required = false): ExtensionList => ({ items, restart_required });

beforeEach(() => {
  useBrowser.setState({ ...initial, open: { ...initial.open, extensions: true } }, true);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "extensionsList").mockResolvedValue(listed());
  vi.spyOn(ipc, "extensionPick").mockResolvedValue(null);
  vi.spyOn(ipc, "extensionSetEnabled").mockResolvedValue(listed([{ ...fixture, enabled: false }], true));
  vi.spyOn(ipc, "extensionRemove").mockResolvedValue(listed([], true));
  vi.spyOn(ipc, "extensionImport").mockResolvedValue(listed([fixture], true));
  vi.spyOn(ipc, "appRestart").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("Extensions", () => {
  it("loads extension details, permissions, and compatibility warnings", async () => {
    render(<Extensions />);
    expect(screen.getByRole("dialog", { name: "Extensions" })).toBeTruthy();
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(screen.getByText("Fixture helper")).toBeTruthy());
    expect(screen.getByText("A compatibility warning.")).toBeTruthy();
    fireEvent.click(screen.getByText("Requested permissions (2)"));
    expect(screen.getByText("storage")).toBeTruthy();
  });

  it("toggles, removes, and advertises the required restart", async () => {
    render(<Extensions />);
    await waitFor(() => expect(screen.getByLabelText("Enable Fixture helper")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Enable Fixture helper"));
    await waitFor(() => expect(ipc.extensionSetEnabled).toHaveBeenCalledWith("fixture-id", false));
    expect(screen.getByText("Restart Dive to apply extension changes.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove Fixture helper"));
    await waitFor(() => expect(ipc.extensionRemove).toHaveBeenCalledWith("fixture-id"));
    expect(screen.getByText("No extensions loaded")).toBeTruthy();
  });

  it("loads a directory selected by the native picker", async () => {
    vi.mocked(ipc.extensionPick).mockResolvedValue("/tmp/new-extension");
    render(<Extensions />);
    fireEvent.click(screen.getByRole("button", { name: "Load unpacked" }));
    await waitFor(() => expect(ipc.extensionImport).toHaveBeenCalledWith("/tmp/new-extension"));
  });

  it("shows backend errors and closes on Escape", async () => {
    vi.mocked(ipc.extensionsList).mockRejectedValueOnce(new Error("registry unreadable"));
    render(<Extensions />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("registry unreadable"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.extensions).toBe(false));
  });
});
