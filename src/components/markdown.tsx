import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small, dependency-free Markdown renderer tuned for chat replies.
 * Supports: fenced code blocks, headings, unordered/ordered lists, blockquotes,
 * paragraphs, and inline bold / italic / `code` / [links](url).
 * Output is composed entirely of real React nodes (no raw HTML injection).
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return <div className={cn("space-y-3", className)}>{parseBlocks(content)}</div>;
}

function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(<CodeBlock key={key++} lang={lang} code={body.join("\n")} />);
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const cls =
        level === 1
          ? "text-base font-semibold"
          : level === 2
            ? "text-sm font-semibold"
            : "text-sm font-medium";
      out.push(
        <p key={key++} className={cls}>
          {parseInline(text)}
        </p>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={key++} className="border-l-2 border-border pl-3 text-muted-foreground">
          {parseInline(body.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // Lists (unordered or ordered)
    const isUl = /^\s*[-*]\s+/.test(line);
    const isOl = /^\s*\d+\.\s+/.test(line);
    if (isUl || isOl) {
      const items: string[] = [];
      const re = isUl ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      while (
        i < lines.length &&
        (isUl ? /^\s*[-*]\s+/.test(lines[i]) : /^\s*\d+\.\s+/.test(lines[i]))
      ) {
        items.push(lines[i].replace(re, ""));
        i++;
      }
      const ListTag = isOl ? "ol" : "ul";
      out.push(
        <ListTag
          key={key++}
          className={cn(
            "space-y-1 pl-5 text-sm leading-relaxed",
            isOl ? "list-decimal" : "list-disc",
          )}
        >
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,3})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
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

// Inline: **bold**, *italic*, `code`, [text](url)
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<strong key={key++}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={key++}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {m[4]}
        </code>,
      );
    } else if (m[5] !== undefined) {
      // Only allow safe schemes — blocks javascript:/data: URLs (XSS).
      const safeHref = /^(https?:|mailto:|\/|#)/i.test(m[6].trim()) ? m[6] : "#";
      nodes.push(
        <a
          key={key++}
          href={safeHref}
          target="_blank"
          rel="noreferrer nofollow"
          className="text-primary underline underline-offset-2"
        >
          {m[5]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
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
