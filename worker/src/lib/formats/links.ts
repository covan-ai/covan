/**
 * Whether a link in a document may stay a link in an exported file.
 *
 * The frontend's Markdown renderer allows the same three schemes
 * (`src/components/markdown.tsx`), and for the same reason: a model wrote this
 * text, and a `javascript:` or `file:` link in a Word file or a PDF is a click
 * somebody did not choose to make. Anything else is kept as its text.
 */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
