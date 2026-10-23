import { toast } from "sonner";
import { englishT, type Translate } from "@/i18n";
import { api } from "@/lib/api-client";

/**
 * Saving a Markdown document as Markdown, Word or PDF — one place for the
 * document panel and the preview dialog, so the two never disagree about what
 * a PDF does on a deployment without a browser to print it.
 *
 * PDF goes to the server first, which prints it with Cloudflare Browser
 * Rendering. Where there is none — Docker, or a deployment that has not bound
 * `BROWSER` — the server says so and the document opens in its print page
 * instead, where the person's own browser saves it as PDF.
 */

export type ExportFormat = "md" | "docx" | "pdf";

export function printPath(documentId: string): string {
  return `/documents/${documentId}/print`;
}

export async function saveDocument(
  documentId: string,
  name: string,
  format: ExportFormat,
  t: Translate = englishT,
): Promise<void> {
  try {
    if (format === "md") {
      await api.documents.download(documentId, name);
      return;
    }
    const outcome = await api.documents.export(documentId, format);
    if (outcome === "print") printInPlace(documentId, t);
  } catch (err) {
    toast.error(
      err instanceof Error && err.message
        ? t("Couldn't save the document: {{message}}", { message: err.message })
        : t("Couldn't save the document"),
    );
  }
}

/**
 * The print page, loaded out of sight in this tab and printed from there.
 *
 * Not a new window: this runs after a request has come back, which is no
 * longer the click, and a browser blocks a window opened then as a pop-up.
 * The page prints itself once the document is on it, and the frame is cleared
 * away a while after — long enough for anybody to finish the print dialog.
 */
function printInPlace(documentId: string, t: Translate): void {
  const frame = document.createElement("iframe");
  frame.title = t("Print document");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.src = printPath(documentId);
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 10 * 60_000);
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}
