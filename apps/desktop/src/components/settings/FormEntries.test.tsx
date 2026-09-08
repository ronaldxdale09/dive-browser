import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormEntry } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { FormEntries, fieldLabel, groupByField } from "./FormEntries";

const entries: FormEntry[] = [
  { id: "f1", profile_id: "p", field: "email", value: "dale@example.com", uses: 12, last_used_at: null },
  { id: "f2", profile_id: "p", field: "email", value: "dee@example.com", uses: 1, last_used_at: null },
  { id: "f3", profile_id: "p", field: "billing_city", value: "Cebu", uses: 3, last_used_at: null },
];
const initial = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "formsList").mockResolvedValue(entries);
  vi.spyOn(ipc, "formsDelete").mockResolvedValue(true);
  vi.spyOn(ipc, "formsClear").mockResolvedValue(3);
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("Settings › Form entries", () => {
  it("groups entries by field with their use counts, forgets one, and forgets all after confirming", async () => {
    render(<FormEntries />);
    expect(await screen.findByText("dale@example.com")).toBeTruthy();
    expect(screen.getByText("billing city")).toBeTruthy();
    expect(screen.getByText("used 12 times")).toBeTruthy();
    expect(screen.getByText("used once")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget dee@example.com" }));
    expect(ipc.formsDelete).toHaveBeenCalledWith("f2");
    await waitFor(() => expect(screen.queryByText("dee@example.com")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Forget all…" }));
    expect(ipc.formsClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(screen.queryByText("Forget all", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Forget all…" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget all" }));
    await waitFor(() => expect(screen.getByText("Nothing remembered yet.")).toBeTruthy());
    expect(ipc.formsClear).toHaveBeenCalledTimes(1);
  });

  it("says when nothing is remembered and when loading failed", async () => {
    vi.mocked(ipc.formsList).mockResolvedValue([]);
    render(<FormEntries />);
    expect(await screen.findByText("Nothing remembered yet.")).toBeTruthy();
    cleanup();
    vi.mocked(ipc.formsList).mockRejectedValue(new Error("no profile"));
    render(<FormEntries />);
    expect((await screen.findByRole("alert")).textContent).toContain("no profile");
  });

  it("labels fields and groups neighbours", () => {
    expect(fieldLabel("billing_email-address")).toBe("billing email address");
    expect(fieldLabel("fullname")).toBe("full name");
    expect(fieldLabel("shipping_postalCode")).toBe("shipping postal code");
    expect(fieldLabel("firstName")).toBe("first name");
    expect(fieldLabel("")).toBe("field");
    expect(groupByField(entries).map((g) => [g.field, g.entries.length])).toEqual([
      ["email", 2],
      ["billing_city", 1],
    ]);
  });
});
