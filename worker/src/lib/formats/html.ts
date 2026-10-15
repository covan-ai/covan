import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../escape-html";
import { safeHref } from "./links";

/**
 * A Markdown document as a page to print — the input to the PDF renderer.
 *
 * WHAT IS NOT TRUSTED. A model wrote this Markdown, and Markdown allows raw
 * HTML. Rendered as written, a `<script>` or an `<img src>` in a report would
 * run inside the headless browser that prints it. So raw HTML is shown as the
 * text it is, links keep only the schemes `safeHref` allows, and images become
 * their alt text. The renderer also turns JavaScript off and refuses every
 * request but the fonts (`lib/formats/pdf.ts`); this is the first of the two
 * walls, not the only one.
 *
 * The look is the product's: DM Sans for headings and Geist for the text,
 * loaded from the app's own `/fonts/` (DESIGN.md §3.2), on white paper.
 */

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

function fontFaces(origin: string | null): string {
  if (!origin) return "";
  const face = (family: string, file: string, range: string) =>
    `@font-face{font-family:"${family}";font-weight:400 600;font-style:normal;` +
    `src:url("${origin}/fonts/${file}") format("woff2");unicode-range:${range};}`;
  return [
    face("DM Sans", "dm-sans-400-600-latin-ext.woff2", LATIN_EXT),
    face("DM Sans", "dm-sans-400-600-latin.woff2", LATIN),
    face("Geist", "geist-400-600-latin-ext.woff2", LATIN_EXT),
    face("Geist", "geist-400-600-latin.woff2", LATIN),
  ].join("\n");
}

const STYLE = `
@page { size: A4; margin: 22mm 20mm 24mm; }
html { color: #251f19; background: #fff; }
body { font-family: "Geist", system-ui, sans-serif; font-size: 10.5pt; line-height: 1.6; margin: 0; }
h1, h2, h3, h4 { font-family: "DM Sans", "Geist", sans-serif; font-weight: 600; line-height: 1.25; break-after: avoid; }
h1 { font-size: 22pt; margin: 0 0 14pt; }
h2 { font-size: 15pt; margin: 22pt 0 8pt; padding-top: 6pt; border-top: 1px solid #e8e6dd; }
h3 { font-size: 12pt; margin: 16pt 0 6pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 12pt 0 4pt; }
p, ul, ol, table, pre, blockquote { margin: 0 0 9pt; }
ul, ol { padding-left: 18pt; }
li { margin: 2pt 0; }
a { color: #251f19; text-decoration: underline; text-decoration-color: #c9c6ba; }
code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 9pt; background: #eeede6; padding: 0 3pt; border-radius: 3px; }
pre { background: #f7f7f4; border: 1px solid #e8e6dd; border-radius: 6px; padding: 8pt 10pt; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #e8e6dd; padding-left: 10pt; color: #5c554c; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; break-inside: auto; }
th, td { border: 1px solid #e8e6dd; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f7f7f4; font-weight: 600; }
tr { break-inside: avoid; }
hr { border: 0; border-top: 1px solid #e8e6dd; margin: 14pt 0; }
`;

function renderer(): Marked {
  return new Marked({
    gfm: true,
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        return href ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
      },
      image(token: Tokens.Image) {
        return escapeHtml(token.text);
      },
    },
  });
}

/** The first heading's text, for the page's `<title>` (the PDF's own title). */
function titleOf(markdown: string): string {
  const match = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+)$/m);
  return match ? match[1].trim() : "Document";
}

export function markdownToPrintHtml(markdown: string, fontOrigin: string | null): string {
  const body = renderer().parse(markdown, { async: false }) as string;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(titleOf(markdown))}</title>`,
    `<style>${fontFaces(fontOrigin)}\n${STYLE}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("\n");
}

/**
 * Where the fonts come from: the app's own origin, the first in
 * `ALLOWED_ORIGIN`. Null when it is not a usable https origin — the PDF is
 * then set in the system's sans-serif rather than reaching anywhere else.
 */
export function fontOriginFrom(allowed: string | undefined): string | null {
  const first = (allowed ?? "").split(",")[0]?.trim();
  if (!first) return null;
  try {
    const url = new URL(first);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}
