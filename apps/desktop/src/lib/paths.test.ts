import { describe, expect, it } from "vitest";
import { fileName, fileNameOr, formatBytes } from "./paths";

describe("fileName", () => {
  it("takes the name off a path from either platform", () => {
    expect(fileName("/Users/dvle/Downloads/quarterly-report.csv")).toBe("quarterly-report.csv");
    // The bug this exists for: splitting on "/" alone left the whole path.
    expect(fileName(String.raw`C:\Users\dvle\Downloads\quarterly-report.csv`)).toBe("quarterly-report.csv");
  });

  it("handles a UNC path and a trailing separator", () => {
    expect(fileName(String.raw`\\server\share\notes.txt`)).toBe("notes.txt");
    expect(fileName("/tmp/folder/")).toBe("folder");
  });

  it("gives nothing for a path with no name, and takes the fallback", () => {
    expect(fileName("")).toBe("");
    expect(fileName("/")).toBe("");
    expect(fileNameOr("", "https://example.com/thing")).toBe("https://example.com/thing");
    expect(fileNameOr("/tmp/a.txt", "unused")).toBe("a.txt");
  });
});

describe("formatBytes", () => {
  it("reads the way a download shelf reads", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1_400_000)).toBe("1.4 MB");
    // Past ten the decimal is noise.
    expect(formatBytes(48_000_000)).toBe("48 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB");
  });

  it("says nothing rather than something wrong", () => {
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});
