/**
 * The injected Markdown extractor, exercised against a DOM.
 *
 * Not to be confused with `markdown.test.ts`, which covers `markdown.tsx` —
 * the chrome's renderer for Markdown the *agent* emits. This file is the
 * other direction: a page turned into Markdown for the agent to read.
 *
 * `page_markdown` exists so an agent can see link targets and table cells
 * that `page_text` flattens away, so the things worth asserting on are the
 * ones a model would act on: where a link goes, which list item nests under
 * which, and whether a checkbox is already ticked.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

/** Render `html` as the whole document body and return the Markdown. */
function md(html: string, cap = 100000): string {
  document.body.innerHTML = html;
  const script = buildInjected("markdown.js", { __MARKDOWN_CAP__: String(cap) });
  const result = eval(script) as { markdown: string; truncated: boolean };
  return result.markdown;
}

function raw(html: string, cap = 100000): { markdown: string; truncated: boolean } {
  document.body.innerHTML = html;
  return eval(buildInjected("markdown.js", { __MARKDOWN_CAP__: String(cap) })) as {
    markdown: string;
    truncated: boolean;
  };
}

describe("markdown extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps heading levels", () => {
    expect(md("<h1>One</h1><h3>Three</h3>")).toBe("# One\n\n### Three");
  });

  it("resolves link targets absolute, so the agent can navigate them", () => {
    // A relative href is useless to a caller that is not the page.
    expect(md('<a href="/docs/start">Get started</a>')).toBe(
      "[Get started](http://localhost:3000/docs/start)",
    );
  });

  it("drops the link syntax for targets that go nowhere", () => {
    expect(md('<a href="javascript:void(0)">Menu</a>')).toBe("Menu");
    expect(md("<a>Bare</a>")).toBe("Bare");
  });

  it("nests and numbers lists", () => {
    const out = md(
      "<ol><li>First<ul><li>Inner</li></ul></li><li>Second</li></ol>",
    );
    expect(out).toBe("1. First\n  - Inner\n2. Second");
  });

  it("deepens by exactly one level per ancestor item", () => {
    // Regression: indenting per nesting depth *and* per continuation line
    // counted every level twice, which reads as a flat list to a parser.
    const out = md("<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>");
    expect(out).toBe("- A\n  - B\n    - C");
  });

  it("honours an ol start attribute", () => {
    expect(md('<ol start="5"><li>Five</li><li>Six</li></ol>')).toBe("5. Five\n6. Six");
  });

  it("emits tables with the separator row that makes them valid Markdown", () => {
    const out = md(
      "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>" +
        "<tbody><tr><td>Bolt</td><td>4</td></tr></tbody></table>",
    );
    expect(out).toBe("| Name | Qty |\n| --- | --- |\n| Bolt | 4 |");
  });

  it("escapes a pipe inside a cell instead of ending the row early", () => {
    const out = md("<table><tr><td>a|b</td><td>c</td></tr></table>");
    expect(out.split("\n")[0]).toBe("| a\\|b | c |");
  });

  it("reports form state, which decides whether the agent types or skips", () => {
    expect(md('<input type="checkbox" checked aria-label="Terms">')).toBe("[x] Terms");
    expect(md('<input type="checkbox" aria-label="Terms">')).toBe("[ ] Terms");
    expect(md('<input aria-label="Email" value="a@b.c">')).toBe("[Email: a@b.c]");
    expect(md("<button>Save</button>")).toBe("[Save]");
  });

  it("skips machinery and hidden subtrees", () => {
    expect(md("<script>var x = 1;</script><p>Real</p>")).toBe("Real");
    expect(md('<div hidden><p>Gone</p></div><p>Real</p>')).toBe("Real");
    expect(md('<div aria-hidden="true"><p>Gone</p></div><p>Real</p>')).toBe("Real");
    expect(md('<div style="display:none"><p>Gone</p></div><p>Real</p>')).toBe("Real");
  });

  it("fences preformatted text without collapsing its whitespace", () => {
    expect(md("<pre><code>a\n  b</code></pre>")).toBe("```\na\n  b\n```");
  });

  it("collapses the blank-line runs the block rules leave behind", () => {
    expect(md("<div><div><div><p>Deep</p></div></div></div>")).toBe("Deep");
  });

  it("caps the result and says so, the way page_text does", () => {
    const result = raw("<p>" + "x".repeat(500) + "</p>", 100);
    expect(result.markdown).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty result rather than throwing on an empty page", () => {
    expect(raw("")).toEqual({ markdown: "", truncated: false });
  });

  it("keeps a link's target when it sits inside a heading", () => {
    expect(md('<h2><a href="https://example.com/x">Docs</a></h2>')).toBe(
      "## [Docs](https://example.com/x)",
    );
  });
});
