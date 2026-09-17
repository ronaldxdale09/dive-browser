import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { TaskRow } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { TaskManager, cpuPercent, formatMemory } from "./TaskManager";

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  tab_id: "t1",
  title: "A heavy page",
  url: "https://example.com",
  memory_bytes: 48 * 1024 * 1024,
  cpu_seconds: 2,
  nodes: 1200,
  documents: 1,
  listeners: 30,
  sleeping: false,
  audible: false,
  ...over,
});

const initial = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "tasksList").mockResolvedValue([row(), row({ tab_id: "t2", title: "A sleeping page", memory_bytes: null, cpu_seconds: null, nodes: null, sleeping: true })]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("formatMemory", () => {
  it("reads in the scale a person acts on", () => {
    expect(formatMemory(48 * 1024 * 1024)).toBe("48 MB");
    expect(formatMemory(200 * 1024)).toBe("200 KB");
    // A renderer holding a handful of bytes is not free; a zero sum is.
    expect(formatMemory(12)).toBe("1 KB");
    expect(formatMemory(0)).toBe("0 KB");
    expect(formatMemory(null)).toBe("—");
  });
});

describe("cpuPercent", () => {
  it("turns two cumulative readings into a rate", () => {
    expect(cpuPercent({ seconds: 1, at: 1000 }, 2, 3000)).toBeCloseTo(50);
    expect(cpuPercent({ seconds: 1, at: 1000 }, 3, 2000)).toBeCloseTo(200);
  });

  it("has nothing to say without a previous reading", () => {
    expect(cpuPercent(undefined, 2, 1000)).toBeNull();
    expect(cpuPercent({ seconds: 1, at: 1000 }, null, 2000)).toBeNull();
  });

  it("counts a restarted renderer as nothing, not as negative work", () => {
    expect(cpuPercent({ seconds: 9, at: 1000 }, 0.2, 3000)).toBeNull();
    expect(cpuPercent({ seconds: 1, at: 1000 }, 2, 1000)).toBeNull();
  });
});

describe("TaskManager", () => {
  it("lists every tab, and says which are asleep rather than free", async () => {
    useBrowser.setState({ open: { ...initial.open, tasks: true } });
    render(<TaskManager />);
    const dialog = await screen.findByRole("dialog", { name: "Task manager" });
    await waitFor(() => expect(screen.getByText("A heavy page")).toBeTruthy());
    expect(dialog.textContent).toContain("48 MB");
    expect(dialog.textContent).not.toMatch(/JavaScript across 2 tabs/);
    expect(dialog.textContent).toContain("48 MB of JavaScript in 1 tab across this profile");
    expect(dialog.textContent).toContain("asleep");
    // The first sample has no rate to show yet.
    expect(dialog.textContent).toContain("—");
  });

  it("does not invent a JavaScript heap when no tab reported one", async () => {
    vi.spyOn(ipc, "tasksList").mockResolvedValue([
      row({ tab_id: "t1", title: "Asleep A", memory_bytes: null, cpu_seconds: null, nodes: null, sleeping: true }),
      row({ tab_id: "t2", title: "Asleep B", memory_bytes: null, cpu_seconds: null, nodes: null, sleeping: true }),
    ]);
    useBrowser.setState({ open: { ...initial.open, tasks: true } });
    render(<TaskManager />);
    const dialog = await screen.findByRole("dialog", { name: "Task manager" });
    await waitFor(() => expect(screen.getByText("Asleep A")).toBeTruthy());
    expect(dialog.textContent).not.toMatch(/1 KB/);
    expect(dialog.textContent).toMatch(/No JavaScript heap reported/);
  });

  it("stays shut until it is opened", () => {
    render(<TaskManager />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.tasksList).not.toHaveBeenCalled();
  });
});
