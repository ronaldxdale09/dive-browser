import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown";

describe("parseBlocks", () => {
  it("separates fenced code from prose and keeps its language", () => {
    const blocks = parseBlocks("Try this:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nDone.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Try this:" },
      { kind: "code", lang: "ts", text: "const a = 1;\n\nconst b = 2;" },
      { kind: "paragraph", text: "Done." },
    ]);
  });
  it("does not lose an unterminated code block while streaming", () => {
    const blocks = parseBlocks("```js\nlet x");
    expect(blocks).toEqual([{ kind: "code", lang: "js", text: "let x" }]);
  });
  it("reads headings, lists and quotes", () => {
    const blocks = parseBlocks("## Plan\n- one\n- two\n  continued\n1. first\n2) second\n> note\n> more");
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "Plan" });
    expect(blocks[1]).toEqual({ kind: "list", ordered: false, items: ["one", "two continued"] });
    expect(blocks[2]).toEqual({ kind: "list", ordered: true, items: ["first", "second"] });
    expect(blocks[3]).toEqual({ kind: "quote", text: "note\nmore" });
  });
  it("ignores a fence-looking line inside a code block only at the closing fence", () => {
    const blocks = parseBlocks("```\na\n```\n```\nb\n```");
    expect(blocks.map((b) => (b.kind === "code" ? b.text : "?"))).toEqual(["a", "b"]);
  });
});

describe("parseInline", () => {
  it("finds code, bold, italic and links, and leaves the rest as text", () => {
    expect(parseInline("Run `npm test` **now** or *later*, see [docs](https://example.com/a?b=1).")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " " },
      { kind: "strong", text: "now" },
      { kind: "text", text: " or " },
      { kind: "em", text: "later" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "docs", href: "https://example.com/a?b=1" },
      { kind: "text", text: "." },
    ]);
  });
  it("never parses markup inside a code span", () => {
    expect(parseInline("`a **b** [c](https://x.y)`")).toEqual([{ kind: "code", text: "a **b** [c](https://x.y)" }]);
  });
  it("does not treat snake_case or a lone asterisk as emphasis", () => {
    expect(parseInline("use tab_id and 2 * 3")).toEqual([{ kind: "text", text: "use tab_id and 2 * 3" }]);
  });
  it("only links http(s) URLs", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
  });
});
