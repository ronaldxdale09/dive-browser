import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../lib/useTabHistory", () => ({
  useTabHistory: () => ({ history, canBack: true, canForward: false }),
}));

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openBackHistory() {
  render(<NavigationButtons tabId="t1" url="https://three.example/" loading={false} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Back" }));
  return screen.getByRole("menu", { name: "Back history" });
}

describe("NavigationButtons history menu", () => {
  it("lists the entries behind the current page, nearest first", () => {
    openBackHistory();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Twohttps://two.example/", "Onehttps://one.example/"]);
  });

  it("moves focus to the hovered row, so only one row is ever highlighted", () => {
    openBackHistory();
    const [first, second] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
    fireEvent.mouseEnter(second!);
    expect(document.activeElement).toBe(second);
  });

  it("closes when the window loses focus, as a click into the page does", () => {
    openBackHistory();
    fireEvent.blur(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside and on Escape", () => {
    openBackHistory();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Back" }));
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
