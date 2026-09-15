import { describe, expect, it } from "vitest";
import { fileName, fileNameOr, formatBytes, opensInTab, fileUrl} from "./paths";

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

describe("opensInTab", () => {
  it("claims the files Dive renders better than the system does", () => {
    expect(opensInTab("/Users/me/Downloads/paper.pdf")).toBe(true);
    expect(opensInTab("C:\\Users\\me\\Downloads\\PAPER.PDF")).toBe(true);
    // Everything else is the system's job.
    expect(opensInTab("/Users/me/Downloads/sheet.csv")).toBe(false);
    expect(opensInTab("/Users/me/Downloads/pdf")).toBe(false);
    expect(opensInTab("/Users/me/pdf.zip")).toBe(false);
    expect(opensInTab("")).toBe(false);
  });
});

describe("fileUrl", () => {
  it("survives the characters a downloaded name actually has", () => {
    expect(fileUrl("/Users/me/Downloads/paper.pdf")).toBe("file:///Users/me/Downloads/paper.pdf");
    // A space or a hash would otherwise truncate the address.
    expect(fileUrl("/Users/me/ICLR 2026 #3.pdf")).toBe("file:///Users/me/ICLR%202026%20%233.pdf");
    // Windows paths take the slash their drive letter needs.
    expect(fileUrl("C:\\Users\\me\\a.pdf")).toBe("file:///C%3A/Users/me/a.pdf");
  });
});
