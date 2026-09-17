import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small, dependency-free Markdown renderer tuned for chat replies.
 *
 * Supports: fenced code blocks, headings, tables, ordered and unordered lists
 * with nesting, blockquotes, horizontal rules, paragraphs, and inline bold /
 * italic / strikethrough / `code` / [links](url). Output is composed entirely
 * of real React nodes — no raw HTML is ever injected.
 *
 * ## Two things it is deliberately not
 *
 * It is not a Markdown implementation. It renders what a language model writes
 * into a chat reply, which is a much smaller grammar than CommonMark: no
 * reference links, no footnotes, no HTML blocks, no setext headings. Every
 * construct here earned its place by turning up in a real answer.
 *
 * It is not a library. `remark` and its plugins do all of the above and more,
 * correctly, for about 60KB — and the reason not to is the one the fenced code
 * path makes obvious: this renders half-finished input on every keystroke of
 * every streamed reply, and needs to do something sensible with a fence that
 * has been opened and not yet closed. That is a requirement most parsers treat
 * as an error case, and it is this one's normal case.
 *
 * ## Streaming
 *
 * Every branch below has to survive text that stops mid-construct, because
 * that is what it is handed for the whole time an answer is arriving: a fence
 * with no closer, a table with a header and no body, a `**` with nothing after
 * it yet. The rule throughout is to render what is there rather than to wait
 * for what is not, so that the answer settles into its final shape instead of
 * snapping into it at the end.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return <div className={cn("space-y-3", className)}>{parseBlocks(content)}</div>;
}

/** An opening fence, and the info string after it (` ```ts title="x" `). */
const FENCE = /^(```+|~~~+)\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `---`, `***`, `___` — three or more of one mark, spaces allowed between. */
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^>\s?/;
/** `- x`, `* x`, `+ x`, keeping the indent that decides nesting. */
const UNORDERED = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
/** The `|---|:--:|` line, which is the only thing that makes the row above a table. */
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

type Align = "left" | "center" | "right";

function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      // First word of the info string. ` ```ts title="x" ` is a real thing
      // models write, and the old pattern — a bare `\w+` to end of line —
      // matched none of it, so the whole block fell through and rendered as
      // paragraphs with the backticks still in them.
      const lang = fence[2].trim().split(/\s+/)[0] ?? "";
      const closer = new RegExp(`^${marker === "`" ? "```+" : "~~~+"}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // Past the closer, or past the end if the answer is still arriving and
      // there is not one yet. Either way the block renders with what it has.
      i++;
      out.push(<CodeBlock key={key++} lang={lang} code={body.join("\n")} />);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key++} className="border-border" />);
      i++;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      out.push(
        <p key={key++} className={headingClass(heading[1].length)}>
          {parseInline(heading[2])}
        </p>,
      );
      i++;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i])) {
        body.push(lines[i].replace(BLOCKQUOTE, ""));
        i++;
      }
      out.push(
        <blockquote key={key++} className="border-l-2 border-border pl-3 text-muted-foreground">
          {parseInline(body.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // A table, which is two lines before it is anything: a header and the
    // `|---|` under it. Without the second the first is an ordinary paragraph
    // that happens to contain pipes — and while a reply is streaming, that is
    // exactly what it is for a moment.
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(<Table key={key++} header={header} aligns={aligns} rows={rows} />);
      continue;
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i, key++);
      out.push(list);
      i = next;
      continue;
    }

    // Paragraph: consecutive lines that start nothing else.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsABlock(lines, i)) {
      para.push(lines[i]);
      i++;
    }
    // A line that starts a block and was not consumed above can only be the
    // first line of this run — otherwise the loop would have stopped before
    // reaching it. Taking it as a paragraph keeps the outer loop moving.
    if (para.length === 0) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="text-sm leading-relaxed">
        {parseInline(para.join(" "))}
      </p>,
    );
  }

  return out;
}

/** Whether the line at `at` opens a block, and so ends the paragraph before it. */
function startsABlock(lines: string[], at: number): boolean {
  const line = lines[at];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BLOCKQUOTE.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    (line.includes("|") && at + 1 < lines.length && TABLE_RULE.test(lines[at + 1]))
  );
}

function headingClass(level: number): string {
  if (level === 1) return "text-base font-semibold";
  if (level === 2) return "text-sm font-semibold";
  // h3 and below all read as the same rank in a chat reply, which is three
  // ranks more than anything a reply needs. Models write `####` freely; there
  // is no visual budget for four sizes inside a paragraph of chat.
  return "text-sm font-medium";
}

/**
 * One list, and any list nested inside its items.
 *
 * Indentation is the whole of it. The old version stripped the leading spaces
 * with the bullet, so `- a` and `  - a` were the same line and every nested
 * list came out flat — which is not a cosmetic loss when the nesting is what
 * carried the meaning, as it is in any answer that breaks a step into
 * sub-steps.
 */
function parseList(lines: string[], start: number, key: number): [ReactNode, number] {
  const first = lines[start].match(UNORDERED) ?? lines[start].match(ORDERED)!;
  const indent = first[1].length;
  const ordered = !UNORDERED.test(lines[start]);

  // Gathered as data and rendered at the end, so an item that turns out to
  // have a list under it is built once with both halves rather than rebuilt
  // from the node already made for it.
  const items: { text: string; nested: ReactNode | null }[] = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(UNORDERED) ?? lines[i].match(ORDERED);
    if (!match) break;
    const at = match[1].length;
    // Shallower than where this list started: it belongs to a list further out.
    if (at < indent) break;
    // Deeper: a nested list, which needs an item above it to hang from. A
    // reply that opens on an indented bullet has none, so there the indent is
    // decoration rather than structure.
    if (at > indent) {
      if (items.length === 0) break;
      const [nested, next] = parseList(lines, i, 0);
      items[items.length - 1].nested = nested;
      i = next;
      continue;
    }
    items.push({ text: match[2], nested: null });
    i++;
  }

  const Tag = ordered ? "ol" : "ul";
  return [
    <Tag
      key={key}
      className={cn(
        "space-y-1 pl-5 text-sm leading-relaxed",
        ordered ? "list-decimal" : "list-disc",
      )}
    >
      {items.map((item, at) => (
        <li key={at}>
          {parseInline(item.text)}
          {item.nested}
        </li>
      ))}
    </Tag>,
    i,
  ];
}

/** `| a | b |` into `["a", "b"]`, tolerating a row written without edge pipes. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignOf(rule: string): Align {
  const left = rule.startsWith(":");
  const right = rule.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

const ALIGN_CLASS: Record<Align, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/**
 * The construct that was missing and cost the most.
 *
 * A model asked to compare three things answers with a table, every time, and
 * a table that falls through to paragraphs is not a degraded table — it is a
 * wall of pipes. Scrolls inside its own box rather than widening the reply,
 * because a chat column is narrow and a comparison of five things is not.
 */
function Table({ header, aligns, rows }: { header: string[]; aligns: Align[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {header.map((cell, i) => (
              <th key={i} className={cn("px-3 py-2 font-medium", ALIGN_CLASS[aligns[i] ?? "left"])}>
                {parseInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border last:border-0">
              {/* Indexed against the header rather than the row, so a short
                  row — which is what a table looks like while it streams —
                  keeps its columns under the right headings. */}
              {header.map((_, c) => (
                <td key={c} className={cn("px-3 py-2", ALIGN_CLASS[aligns[c] ?? "left"])}>
                  {parseInline(row[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Inline marks: **bold**, *italic*, ~~struck~~, `code`, [text](url).
 *
 * Each wrapping mark recurses on what it wrapped, which is what makes
 * `**bold with *emphasis* inside**` work. The old patterns matched `[^*]+` —
 * "anything but a star" — so a nested mark stopped the outer one from
 * matching at all, and the fallback was the *italic* alternative eating the
 * first two stars. `**bold *inner* **` rendered as italic "bold ".
 *
 * Non-greedy rather than negated, so the closing mark is the nearest one and
 * an unmatched opener at the end of a streaming reply stays literal text
 * instead of swallowing the rest of the answer.
 */
const INLINE =
  /(\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/s;

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));

    if (m[2] !== undefined) {
      nodes.push(<strong key={key++}>{parseInline(m[2])}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<del key={key++}>{parseInline(m[3])}</del>);
    } else if (m[4] !== undefined) {
      nodes.push(<em key={key++}>{parseInline(m[4])}</em>);
    } else if (m[5] !== undefined) {
      // No recursion: what is inside a code span is text, by definition.
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {m[5]}
        </code>,
      );
    } else {
      // Only safe schemes — blocks javascript:/data: URLs (XSS).
      const href = /^(https?:|mailto:|\/|#)/i.test(m[7].trim()) ? m[7] : "#";
      nodes.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer nofollow"
          className="text-primary underline underline-offset-2"
        >
          {parseInline(m[6])}
        </a>,
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }

  return nodes;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{lang || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5">
        <code className="font-mono text-xs leading-relaxed">{code}</code>
      </pre>
    </div>
  );
}
