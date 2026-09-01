import { escapeHtml } from "./escape-html";

/**
 * Escape first, convert second.
 *
 * Everything below builds HTML out of a string that came back from a model,
 * which in turn read fetched web pages — so the source is untrusted and the
 * order is not negotiable. Escaping after conversion would undo the tags this
 * function had just decided to emit.
 */

/**
 * Styles are inline because a mail client is allowed to drop a `<style>` block
 * and several do. Every rule that matters therefore sits on the element it
 * styles, which is verbose in the source and the only thing that renders
 * everywhere.
 */
const P = 'style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#251f19"';
const H = 'style="margin:24px 0 10px;font-size:17px;font-weight:600;color:#251f19"';
// `list-style:square` rather than the default disc: DESIGN.md §3 makes every
// bullet, mark and avatar in the product a square, and a mail is not the place
// the rule stops.
const UL = 'style="margin:0 0 16px;padding-left:20px;list-style:square"';
const LI = 'style="margin:0 0 6px;font-size:15px;line-height:1.55;color:#251f19"';

/**
 * Inline marks, applied to text that is already escaped.
 *
 * Bold before italic, because `**x**` would otherwise match the single-asterisk
 * rule twice and come out as `<em><em>x</em></em>`. Both patterns refuse to span
 * a newline, so an asterisk used as a bullet or left dangling in prose stays the
 * character it is instead of swallowing the rest of the paragraph.
 */
function inlineMarks(escaped: string): string {
  return links(
    escaped
      .replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, "$1<em>$2</em>"),
  );
}

/**
 * The only two schemes that become an `href`.
 *
 * A routine summarises pages it fetched, so both halves of `[text](url)` are
 * attacker-controlled and the scheme is the half that matters: `javascript:` in
 * an anchor is a link that runs rather than navigates. Anything else keeps its
 * brackets and stays visible text — inert, and obviously not a link.
 */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

const A = 'style="color:#251f19;text-decoration:underline"';

/**
 * Markdown links first, then bare URLs.
 *
 * The two passes cannot simply run in sequence over the same string: the first
 * writes URLs into `href` attributes, and the second would then find them there
 * and link them again, inside out. So each finished anchor is parked behind a
 * placeholder from a private-use codepoint — which escaping guarantees is not in
 * the text — and put back once the bare-URL pass is done.
 */
function links(text: string): string {
  const parked: string[] = [];
  const park = (html: string) => {
    parked.push(html);
    return `${parked.length - 1}`;
  };

  const withMarkdownLinks = text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (whole, label: string, url: string) =>
      isSafeUrl(url) ? park(`<a href="${url}" ${A}>${label}</a>`) : whole,
  );

  // Trailing punctuation is not part of the address: a sentence ending "see
  // https://example.com." should not link the full stop.
  const withBareLinks = withMarkdownLinks.replace(/https?:\/\/[^\s<]+/gi, (url) => {
    const trimmed = url.replace(/[.,;:)\]]+$/, "");
    return park(`<a href="${trimmed}" ${A}>${trimmed}</a>`) + url.slice(trimmed.length);
  });

  return withBareLinks.replace(/(\d+)/g, (_, i: string) => parked[Number(i)]);
}

/** A blank line — one or more — is what separates two blocks. */
function blocksOf(source: string): string[] {
  return source
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

const BULLET = /^[-*]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/**
 * One block, which is not the same as one element.
 *
 * A model writes a lead line and its bullets with no blank line between them —
 * "Three things stood out:" followed by three dashes — so a block is walked line
 * by line and a run of bullets becomes a list wherever it starts. Splitting only
 * on blank lines would have made that whole block one paragraph with the dashes
 * still in it, which is the thing this file exists to stop.
 */
function renderBlock(block: string): string {
  const out: string[] = [];
  let bullets: string[] = [];
  let prose: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets.map((b) => `<li ${LI}>${b}</li>`).join("");
    out.push(`<ul ${UL}>${items}</ul>`);
    bullets = [];
  };
  const flushProse = () => {
    if (prose.length === 0) return;
    // A single newline inside a paragraph is a wrap the model chose, not a
    // break the reader asked for — but dropping it entirely runs two sentences
    // together, so it becomes a `<br>`.
    out.push(`<p ${P}>${prose.join("<br>")}</p>`);
    prose = [];
  };

  for (const rawLine of block.split("\n")) {
    const line = inlineMarks(escapeHtml(rawLine.trim()));
    if (line.length === 0) continue;

    const heading = line.match(HEADING);
    if (heading) {
      flushBullets();
      flushProse();
      out.push(`<h2 ${H}>${heading[1]}</h2>`);
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      flushProse();
      bullets.push(bullet[1]);
      continue;
    }

    flushBullets();
    prose.push(line);
  }

  flushBullets();
  flushProse();
  return out.join("\n");
}

export function renderMarkdown(source: string): string {
  return blocksOf(source).map(renderBlock).join("\n");
}
