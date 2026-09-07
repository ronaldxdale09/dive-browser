import { describe, expect, it } from "vitest";
import { resolveImage } from "./MetaPanel";

describe("social card image", () => {
  it("resolves relative og:image paths against the page and drops what a crawler could not fetch", () => {
    expect(resolveImage("/img/card.png", "https://example.com/post/1")).toBe("https://example.com/img/card.png");
    expect(resolveImage("https://cdn.example.com/c.png", "https://example.com/")).toBe("https://cdn.example.com/c.png");
    expect(resolveImage("data:image/png;base64,AA", "https://example.com/")).toBeUndefined();
    expect(resolveImage(undefined, "https://example.com/")).toBeUndefined();
    expect(resolveImage("card.png", "not a url")).toBeUndefined();
  });
});
