import { Check, Copy } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { copyText } from "./clipboard";

/**
 * A small Markdown renderer for agent replies: fenced code, inline code,
 * headings, lists, quotes, simple tables, emphasis and links. No raw HTML ever reaches the
 * DOM -- everything is built from React nodes -- and links are handed to a
 * callback rather than rendered as anchors, so the chrome decides what
 * opening one means (a new tab in the browser, not the chrome webview).
 *
 * It is deliberately not a full parser. The model writes prose with code in
 * it; that is what this has to get right, and a dependency for it would be
 * the largest thing in the bundle.
 */

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string };

/** `| --- | :---: |`: the line under a table's header. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** A table row's cells, without the outer pipes. `\|` is a literal pipe. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Split Markdown into block-level pieces. Exported for tests. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence, or end of input for an unterminated block
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    // A GitHub table: a row of cells, then the rule under it. The rule is
    // what makes it a table -- a line with a pipe in it alone is prose.
    const rule = lines[i + 1];
    if (line.includes("|") && rule !== undefined && TABLE_RULE.test(rule) && rule.includes("|")) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        const cells = tableCells(lines[i++]!);
        // Rows are as wide as the header, as GitHub renders them.
        rows.push(header.map((_, c) => cells[c] ?? ""));
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }
    const unordered = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (unordered.test(line) || numbered.test(line)) {
      flush();
      // A run of one kind is one list; a numbered item right after bullets
      // starts a new list rather than joining the old one.
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : unordered;
      const anyMarker = (l: string) => unordered.test(l) || numbered.test(l);
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i]!)) {
        let item = lines[i]!.replace(marker, "");
        i++;
        // A continuation line indented under the item belongs to it.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !anyMarker(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(item);
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return blocks;
}

type Inline = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "strong"; text: string } | { kind: "em"; text: string } | { kind: "link"; text: string; href: string };

/** Split a run of text into inline pieces. Exported for tests. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  // Code spans first so their contents are never re-parsed; then links,
  // bold, italic. Anything else is literal text.
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: src.slice(last, at) });
    if (m[2] !== undefined) out.push({ kind: "code", text: m[2].trim() });
    else if (m[3] !== undefined && m[4] !== undefined) out.push({ kind: "link", text: m[3], href: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "strong", text: m[5] });
    else if (m[6] !== undefined) out.push({ kind: "strong", text: m[6] });
    else if (m[7] !== undefined) out.push({ kind: "em", text: m[7] });
    else if (m[8] !== undefined) out.push({ kind: "em", text: m[8] });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

// While a reply streams only its last block changes; memo keeps the blocks
// above it from re-parsing on every flush.
const Inlines = memo(function Inlines({ text, onLink }: { text: string; onLink?: ((href: string) => void) | undefined }) {
  return (
    <>
      {parseInline(text).map((piece, i) => {
        switch (piece.kind) {
          case "code":
            return (
              <code key={i} className="rounded-[5px] bg-surface-3 px-1 py-px font-mono text-[11px] [overflow-wrap:anywhere] text-ink">
                {piece.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                {piece.text}
              </strong>
            );
          case "em":
            return <em key={i}>{piece.text}</em>;
          case "link":
            return (
              <button key={i} type="button" onClick={() => onLink?.(piece.href)} title={piece.href} className="text-highlight underline decoration-highlight/40 underline-offset-2 hover:decoration-highlight">
                {piece.text}
              </button>
            );
          default:
            return <span key={i}>{piece.text}</span>;
        }
      })}
    </>
  );
});

/** How long a copy button says it copied. */
const COPIED_MS = 1500;

/**
 * A fenced block with its own copy button. Code in a reply is usually there
 * to be pasted somewhere, and selecting it by hand in a dock this small
 * tended to catch the language label or miss the last line.
 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy code";
  return (
    <div className="group/code relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-ground p-2.5 font-mono text-[11px] leading-relaxed text-ink select-text">
        {lang && <span className="mb-1.5 block text-[10px] tracking-wider text-ink-3 uppercase">{lang}</span>}
        <code>{text}</code>
      </pre>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          copyText(text).then(
            () => setCopied("yes"),
            () => setCopied("failed"),
          );
        }}
        className={`absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md border border-line bg-surface text-ink-3 transition-opacity hover:text-ink focus-visible:opacity-100 ${
          copied ? "opacity-100" : "opacity-0 group-hover/code:opacity-100"
        }`}
      >
        <Icon icon={copied === "yes" ? Check : Copy} size={12} className={copied === "yes" ? "text-highlight" : copied === "failed" ? "text-danger" : undefined} />
      </button>
    </div>
  );
}

/** A GitHub table, scrolling sideways rather than squeezing its columns. */
function Table({ header, rows, onLink }: { header: string[]; rows: string[][]; onLink?: ((href: string) => void) | undefined }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="bg-surface-2 text-ink">
          <tr>
            {header.map((cell, c) => (
              <th key={c} className="border-b border-line px-2 py-1 font-semibold">
                <Inlines text={cell} onLink={onLink} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-line/60 last:border-b-0">
              {row.map((cell, c) => (
                <td key={c} className="px-2 py-1 align-top text-ink-2">
                  <Inlines text={cell} onLink={onLink} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render Markdown as chrome-styled React. */
export function Markdown({ text, onLink }: { text: string; onLink?: ((href: string) => void) | undefined }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case "heading":
            return (
              <div key={i} className={`font-semibold text-ink ${b.level <= 2 ? "text-[13px]" : "text-xs"}`}>
                <Inlines text={b.text} onLink={onLink} />
              </div>
            );
          case "list":
            return b.ordered ? (
              <ol key={i} className="list-decimal space-y-1 pl-5">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines text={item} onLink={onLink} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines text={item} onLink={onLink} />
                  </li>
                ))}
              </ul>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-line-2 pl-3 text-ink-2">
                <Inlines text={b.text} onLink={onLink} />
              </blockquote>
            );
          case "table":
            return <Table key={i} header={b.header} rows={b.rows} onLink={onLink} />;
          default:
            return (
              // A URL or a hash with no spaces is one word as far as the
              // browser is concerned; without this it ran out of the bubble.
              <p key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                <Inlines text={b.text} onLink={onLink} />
              </p>
            );
        }
      })}
    </div>
  );
}
