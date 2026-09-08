import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { buildEditorUri, jumpToSource, localPath } from "./editor";

afterEach(() => vi.restoreAllMocks());

describe("editor links", () => {
  it("builds file URIs for the chosen editor and refuses served URLs as paths", () => {
    expect(localPath("file:///Users/me/app/src/a.ts?x#y")).toBe("/Users/me/app/src/a.ts");
    expect(localPath("/Users/me/app/src/a.ts")).toBe("/Users/me/app/src/a.ts");
    expect(localPath("http://127.0.0.1:8771/console.html")).toBeNull();
    expect(localPath("blob:http://a.test/uuid")).toBeNull();
    expect(localPath("src/a.ts")).toBeNull();
    expect(buildEditorUri("cursor", "/Users/me/a.ts", 3, 7)).toBe("cursor://file/Users/me/a.ts:3:7");
    expect(buildEditorUri("zed", "file:///Users/me/a.ts")).toBe("zed://file/Users/me/a.ts:1:1");
  });

  it("opens the editor only when a location maps to a file on disk", async () => {
    vi.spyOn(ipc, "resolveFrame").mockResolvedValue(null);
    const served = await jumpToSource("t1", "http://127.0.0.1:8771/console.html", 8, 1, "vscode");
    expect(served.opened).toBe(false);
    if (!served.opened) expect(served.reason).toContain("127.0.0.1:8771");

    vi.spyOn(ipc, "resolveFrame").mockResolvedValue({ source: "/Users/me/app/src/a.ts", line: 12, column: 3 } as never);
    const mapped = await jumpToSource("t1", "http://127.0.0.1:5173/assets/a.js", 1, 1, "vscode");
    expect(mapped).toEqual({ opened: true, uri: "vscode://file/Users/me/app/src/a.ts:12:3" });
  });
});
