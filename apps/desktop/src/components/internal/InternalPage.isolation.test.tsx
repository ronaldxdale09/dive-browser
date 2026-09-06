import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Tab } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { InternalPage } from "./InternalPage";

vi.mock("../capture/CaptureStudio", () => ({ CaptureStudio: () => { throw Error("capture failed"); } }));
vi.mock("../../screen/DiveScreen", () => ({ DiveScreen: () => { throw Error("recording failed"); } }));
const initial = useBrowser.getState();
afterEach(() => { cleanup(); useBrowser.setState(initial, true); vi.restoreAllMocks(); });

it.each([["capture", "Capture editor"], ["screen", "Recording editor"]])("isolates the %s editor and closes only its tab", async (page, label) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const closeTab = vi.fn().mockResolvedValue(undefined);
  useBrowser.setState({ closeTab });
  const tab: Tab = { id: "editor", workspace_id: "w1", tier: "today", url: `dive://${page}?src=fixture`, title: "", favicon: null, position: 0, state: "active", last_active_at: "2026-09-05T00:00:00Z" };
  render(<><button>Address bar</button><InternalPage tab={tab} /></>);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Address bar" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Close ${label}` }));
  expect(closeTab).toHaveBeenCalledExactlyOnceWith("editor");
});
