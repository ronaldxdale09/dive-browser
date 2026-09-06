import { describe, expect, it } from "vitest";
import { pickInstalledModel } from "./modelChoice";

const list = [
  { id: "bge-m3:latest", name: "bge-m3:latest" },
  { id: "qwen2.5:0.5b", name: "qwen2.5:0.5b" },
] as never;

describe("pickInstalledModel", () => {
  it("keeps a preferred model that is installed", () => {
    expect(pickInstalledModel(list, "qwen2.5:0.5b")).toBe("qwen2.5:0.5b");
  });
  it("skips embedding models when the preferred one is missing", () => {
    expect(pickInstalledModel(list, "qwen3")).toBe("qwen2.5:0.5b");
  });
  it("has nothing to offer for an empty list", () => {
    expect(pickInstalledModel([], "qwen3")).toBeNull();
  });
});
