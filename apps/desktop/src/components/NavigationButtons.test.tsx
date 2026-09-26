import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { NavigationHistory } from "../lib/ipc";
import { NavigationButtons } from "./NavigationButtons";

const history: NavigationHistory = {
  generation: "g1",
  current_index: 2,
  entries: [
    { id: 1, url: "https://one.example/", title: "One" },
    { id: 2, url: "https://two.example/", title: "Two" },
    { id: 3, url: "https://three.example/", title: "Three" },
  ],
};

let shown: NavigationHistory = history;

vi.mock("../lib/useTabHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useTabHistory")>()),
  useTabHistory: () => ({ canBack: true, canForward: false, loadHistory: () => Promise.resolve(shown) }),
}));

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  shown = history;
  vi.restoreAllMocks();
});

async function openBackHistory() {
  render(<NavigationButtons tabId="t1" url="https://three.example/" />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Back" }));
  return screen.findByRole("menu", { name: "Back history" });
}

describe("NavigationButtons history menu", () => {
  it("leaves out the blank page a new tab's view started on", async () => {
    shown = { ...history, entries: [{ id: 0, url: "about:blank", title: "" }, ...history.entries], current_index: 3 };
    await openBackHistory();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Twohttps://two.example/", "Onehttps://one.example/"]);
  });

  it("lists the entries behind the current page, nearest first", async () => {
    await openBackHistory();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Twohttps://two.example/", "Onehttps://one.example/"]);
  });

  it("moves focus to the hovered row, so only one row is ever highlighted", async () => {
    await openBackHistory();
    const [first, second] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
    fireEvent.mouseEnter(second!);
    expect(document.activeElement).toBe(second);
  });

  it("closes when the window loses focus, as a click into the page does", async () => {
    await openBackHistory();
    fireEvent.blur(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside and on Escape", async () => {
    await openBackHistory();
    fireEvent.mouseDown(document.body);
    // The history under the menu is read when it opens; under a loaded test
    // run that read can still be settling when the press lands.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(screen.getByRole("button", { name: "Back" }));
    fireEvent.keyDown((await screen.findAllByRole("menuitem"))[0]!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
