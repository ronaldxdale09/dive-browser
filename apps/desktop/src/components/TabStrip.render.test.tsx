import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useTabAudio } from "../store/tabAudio";
import { TabStrip } from "./TabStrip";

// Each tab draws its favicon once per render, so counting favicons counts tab renders.
const renders = new Map<string, number>();
vi.mock("./Favicon", () => ({
  Favicon: ({ src }: { src: string | null }) => {
    renders.set(src ?? "", (renders.get(src ?? "") ?? 0) + 1);
    return null;
  },
}));

const tab = (id: string, title: string): Tab => ({ id, workspace_id: "w1", url: `https://${id}.test/`, title, favicon: `${id}.png`, tier: "today", position: 0, last_active_at: "", state: "active" }) as Tab;
const initial = useBrowser.getState();

afterEach(() => {
  cleanup();
  renders.clear();
  useBrowser.setState(initial, true);
  useTabAudio.setState({ byTab: {} });
});

it("re-renders only the tab whose title, load state or sound changed", () => {
  const a = tab("a", "Alpha");
  const b = tab("b", "Beta");
  useBrowser.setState({ tabs: [a, b], activeTab: "a", activeWorkspace: "w1", detached: [], loading: {} });
  render(<TabStrip />);
  expect(renders.get("b.png")).toBeGreaterThan(0);
  renders.clear();

  act(() => useBrowser.setState({ tabs: [{ ...a, title: "Alpha, renamed" }, b] }));
  expect(screen.getByRole("tab", { name: "Alpha, renamed" })).toBeTruthy();
  act(() => useBrowser.setState({ loading: { a: true } }));
  expect(screen.getAllByRole("img", { name: "Loading" })).toHaveLength(1);
  act(() => useTabAudio.setState({ byTab: { a: { tab_id: "a", audible: true, muted: false } } }));

  expect(renders.get("b.png") ?? 0).toBe(0);
});
