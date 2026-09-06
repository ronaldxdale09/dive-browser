import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { renameBookmark } from "./bookmarks";

afterEach(() => vi.restoreAllMocks());

describe("renameBookmark", () => {
  it("renames through the engine, trimming the title", async () => {
    const rename = vi.spyOn(ipc, "bookmarkRename").mockResolvedValue(null);
    await renameBookmark("https://example.com/", "  New name ");
    expect(rename).toHaveBeenCalledWith("https://example.com/", "New name");
  });
  it("ignores a blank title", async () => {
    const rename = vi.spyOn(ipc, "bookmarkRename").mockResolvedValue(null);
    await renameBookmark("https://example.com/", "   ");
    expect(rename).not.toHaveBeenCalled();
  });
});
