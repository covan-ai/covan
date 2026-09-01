/**
 * The body of a hand-written email.
 *
 * Every message in this folder is our own prose rather than a model's, so none
 * of them goes through `email-markdown` — there is nothing to parse and nothing
 * untrusted to escape. What they do share is the paragraph rule, which has to be
 * inline for the same reason every other rule in `email-layout` is: a mail
 * client is allowed to drop a `<style>` block, and several do.
 *
 * Interpolated values are the exception. A workspace name or somebody's own name
 * is whatever they typed into a form, so it passes through `escapeHtml` at the
 * call site — the shell escapes what it is handed as text, and this helper is
 * handed HTML.
 */
export const P = "margin:0 0 16px;font-size:15px;line-height:1.55;color:#251f19";

/** Wrap each already-HTML fragment in the shared paragraph rule. */
export function paragraphs(...html: string[]): string {
  return html.map((line) => `<p style="${P}">${line}</p>`).join("");
}
