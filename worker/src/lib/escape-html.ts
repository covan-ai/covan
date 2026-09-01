/**
 * The one place that turns text into text-inside-HTML.
 *
 * Both halves of an email need this and they need it to agree: `email-markdown`
 * escapes a model's summary before converting it, and `email-layout` escapes the
 * workspace and people's names it puts in the chrome around it. A second copy
 * that handled one character differently would be a hole in whichever file was
 * not being read at the time.
 *
 * The quote is escaped along with the angle brackets because some of this text
 * lands in an attribute — a preheader, an `alt` — where `<` alone is harmless
 * and `"` is what ends the attribute early.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
