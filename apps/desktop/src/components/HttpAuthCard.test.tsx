import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { HttpAuthAsked } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { useHttpAuth } from "../store/httpAuth";
import { HttpAuthCard } from "./HttpAuthCard";

const asked: HttpAuthAsked = { tab_id: "t1", request_id: "r1", host: "example.com", realm: "", scheme: "basic", is_proxy: false, secure: true };
const initialBrowser = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "httpAuthPending").mockResolvedValue([asked]);
  vi.spyOn(ipc, "httpAuthAnswer").mockResolvedValue(null);
  useHttpAuth.setState({ byTab: { t1: [asked] }, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
});

describe("HttpAuthCard", () => {
  it("signs in on Enter, but not on an Enter that confirms an input method candidate", async () => {
    render(<HttpAuthCard tabId="t1" />);
    const field = screen.getByRole("textbox", { name: "Username" });
    fireEvent.change(field, { target: { value: "ni" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(ipc.httpAuthAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(ipc.httpAuthAnswer).toHaveBeenCalledWith("t1", "r1", "ni", ""));
  });
});
