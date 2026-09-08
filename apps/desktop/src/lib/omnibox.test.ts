import { describe, expect, it } from "vitest";
import type { Bookmark, HistoryEntry, Tab } from "./ipc";
import { buildSuggestions, hostOf, looksLikeUrl, placeOf, stepHighlight } from "./omnibox";

const tab = (id: string, url: string, title: string): Tab => ({
  id,
  workspace_id: "w",
  tier: "today",
  url,
  title,
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-06T00:00:00Z",
});
const bookmark = (url: string, title: string): Bookmark => ({ url, title, created_at: "2026-09-06T00:00:00Z", favicon: null });
const visit = (url: string, title: string): HistoryEntry => ({ url, title, last_visited_at: "2026-09-06T00:00:00Z", visits: 1, favicon: null });

describe("placeOf", () => {
  it("keeps host and path, drops scheme, query and a trailing slash", () => {
    expect(placeOf("https://www.wikipedia.org/wiki/Main_Page?x=1#top")).toBe("www.wikipedia.org/wiki/Main_Page");
    expect(placeOf("http://localhost:8771/")).toBe("localhost:8771");
    expect(placeOf("http://localhost:8771/form.html")).toBe("localhost:8771/form.html");
    expect(placeOf("dive://capture")).toBe("dive://capture");
    expect(placeOf("not a url")).toBe("");
  });
});

describe("hostOf", () => {
  it("names a site by its host and one of Dive's own pages by its whole address", () => {
    expect(hostOf("https://www.wikipedia.org/wiki/Main_Page")).toBe("www.wikipedia.org");
    expect(hostOf("dive://capture")).toBe("dive://capture");
    expect(hostOf("not a url")).toBe("");
  });
});

describe("looksLikeUrl", () => {
  it.each(["example.com", "https://x.test/a b", "localhost:3000", "127.0.0.1", "dive://screen", "docs.rs/serde"])("treats %s as an address", (input) => {
    expect(looksLikeUrl(input)).toBe(true);
  });
  it.each(["", "  ", "how to fold a shirt", "rust", "a.b c"])("treats %j as a search", (input) => {
    expect(looksLikeUrl(input)).toBe(false);
  });
});

describe("buildSuggestions", () => {
  const sources = {
    tabs: [tab("t1", "https://example.com/docs", "Example docs"), tab("t2", "https://other.test/", "Other")],
    bookmarks: [bookmark("https://example.com/docs", "Example docs"), bookmark("https://bookmarked.test/ex", "Saved example")],
    history: [visit("https://history.test/example", "Past example"), visit("https://other.test/", "Other again")],
  };

  it("offers nothing for an empty draft", () => {
    expect(buildSuggestions("   ", sources)).toEqual([]);
  });

  it("lists each URL once, tabs before bookmarks before history, and leads with the site the letters begin", () => {
    const rows = buildSuggestions("example", sources);
    expect(rows.map((r) => `${r.kind}:${r.url}`)).toEqual([
      "tab:https://example.com/docs",
      "search:example",
      "bookmark:https://bookmarked.test/ex",
      "history:https://history.test/example",
    ]);
    expect(rows[0]).toMatchObject({ kind: "tab", tabId: "t1" });
  });

  it("keeps the literal row first when nothing begins with the letters, or when an address was typed", () => {
    expect(buildSuggestions("past", sources).map((r) => r.kind)).toEqual(["search", "history"]);
    expect(buildSuggestions("other.test", sources)[0]).toMatchObject({ kind: "open", url: "other.test" });
    expect(buildSuggestions("www", { tabs: [tab("t9", "https://www.wikipedia.org/", "Wiki")], bookmarks: [], history: [] })[0]?.kind).toBe("tab");
  });

  it("names a page by its address when its recorded title is blank or about:blank", () => {
    const rows = buildSuggestions("iana", { tabs: [], bookmarks: [], history: [visit("https://www.iana.org/help", "about:blank"), visit("https://iana.test/", "")] });
    expect(rows.filter((r) => r.kind === "history").map((r) => r.title)).toEqual(["https://www.iana.org/help", "https://iana.test/"]);
  });

  it("matches case-insensitively on title or URL and says Open for an address", () => {
    const rows = buildSuggestions("OTHER.test", sources);
    expect(rows[0]).toMatchObject({ kind: "open", url: "OTHER.test" });
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["tab"]);
  });

  it("caps the list", () => {
    const many = { tabs: [], bookmarks: [], history: Array.from({ length: 20 }, (_, i) => visit(`https://h.test/${i}`, `page ${i}`)) };
    expect(buildSuggestions("page", many)).toHaveLength(8);
    expect(buildSuggestions("page", many, 3)).toHaveLength(3);
  });
});

describe("stepHighlight", () => {
  it("wraps at both ends and stays put on an empty list", () => {
    expect(stepHighlight(0, 3, 1)).toBe(1);
    expect(stepHighlight(2, 3, 1)).toBe(0);
    expect(stepHighlight(0, 3, -1)).toBe(2);
    expect(stepHighlight(4, 0, 1)).toBe(0);
  });
});
