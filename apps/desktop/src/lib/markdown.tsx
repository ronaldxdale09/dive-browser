import { useMemo } from "react";
import type { ReactNode } from "react";

/**
 * A small Markdown renderer for agent replies: fenced code, inline code,
 * headings, lists, quotes, emphasis and links. No raw HTML ever reaches the
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
  | { kind: "paragraph"; text: string };

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

function Inlines({ text, onLink }: { text: string; onLink?: ((href: string) => void) | undefined }) {
  return (
    <>
      {parseInline(text).map((piece, i) => {
        switch (piece.kind) {
          case "code":
            return (
              <code key={i} className="rounded-[5px] bg-surface-3 px-1 py-px font-mono text-[11px] text-ink">
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
}

/** Render Markdown as chrome-styled React. */
export function Markdown({ text, onLink }: { text: string; onLink?: ((href: string) => void) | undefined }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-lg border border-line bg-ground p-2.5 font-mono text-[11px] leading-relaxed text-ink select-text">
                {b.lang && <span className="mb-1.5 block text-[10px] tracking-wider text-ink-3 uppercase">{b.lang}</span>}
                <code>{b.text}</code>
              </pre>
            );
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
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                <Inlines text={b.text} onLink={onLink} />
              </p>
            );
        }
      })}
    </div>
  );
}
