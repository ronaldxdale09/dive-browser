import { describe, expect, it } from "vitest";
import { orderTabs } from "./TabStrip";
import type { Tab } from "../lib/ipc";

const t = (id: string, tier: Tab["tier"], position: number, state: Tab["state"] = "active"): Tab =>
  ({ id, workspace_id: "w", tier, url: "https://x", title: "", position, state, last_active_at: "2026-01-01T00:00:00Z" }) as Tab;

describe("orderTabs", () => {
  it("puts pinned first, sorts by position, hides essentials and discarded", () => {
    const out = orderTabs([t("c", "today", 2), t("p", "pinned", 9), t("a", "today", 0), t("e", "essential", 0), t("d", "today", 1, "discarded")]);
    expect(out.map((x) => x.id)).toEqual(["p", "a", "c"]);
  });
});
