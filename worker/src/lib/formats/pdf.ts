import type { Bindings } from "../../types";
import { fontOriginFrom, markdownToPrintHtml } from "./html";

/**
 * A Markdown document as a PDF, printed by a real browser.
 *
 * A PDF that looks like the document is a browser's job — line breaking,
 * tables that split across pages, Turkish glyphs in the right face — and
 * Cloudflare rents one: Browser Rendering, bound as `BROWSER`. Nothing here
 * runs on Node, and nothing has to: without the binding `pdfRenderer` answers
 * null, the route says so (501), and the page falls back to the person's own
 * browser printing the document (`src/routes/_authed.documents.$documentId.print.tsx`).
 * A Docker install therefore gets a PDF too, through the print dialog, and
 * needs no Chromium in its image for it.
 *
 * `@cloudflare/puppeteer` is imported only when there is a binding to use it
 * with, so the Node entry never loads it.
 *
 * THE BROWSER IS LOCKED DOWN, because what it renders was written by a model.
 * `markdownToPrintHtml` already shows raw HTML as text; on top of that
 * JavaScript is off and every request is refused except the app's own fonts,
 * so a document cannot make the renderer fetch anything on its behalf.
 */

export interface PdfRenderer {
  render(markdown: string): Promise<Uint8Array>;
}

/** How long a page may take to print before the export gives up. */
const RENDER_TIMEOUT_MS = 30_000;

export function pdfRenderer(env: Bindings): PdfRenderer | null {
  const binding = env.BROWSER;
  if (!binding) return null;
  const fontOrigin = fontOriginFrom(env.ALLOWED_ORIGIN);

  return {
    async render(markdown) {
      const { default: puppeteer } = await import("@cloudflare/puppeteer");
      const browser = await puppeteer.launch(binding as never);
      try {
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const url = request.url();
          const allowed =
            url.startsWith("data:") ||
            url === "about:blank" ||
            (fontOrigin !== null && url.startsWith(`${fontOrigin}/fonts/`));
          if (allowed) void request.continue();
          else void request.abort();
        });
        await page.setContent(markdownToPrintHtml(markdown, fontOrigin), {
          waitUntil: "networkidle0",
          timeout: RENDER_TIMEOUT_MS,
        });
        const pdf = await page.pdf({
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true,
          timeout: RENDER_TIMEOUT_MS,
        });
        return new Uint8Array(pdf);
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}
