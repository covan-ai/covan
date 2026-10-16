/**
 * The small readers every provider's half of the catalogue uses to turn a
 * delivery into a paragraph: a field that may be missing or the wrong type,
 * an object that may not be one, a header block that leaves out what is
 * empty, and a body cut to a length a model should read.
 *
 * Here rather than in each provider's file because they are the same four
 * functions everywhere, and a cut that says "[…cut at 6000 characters]" in one
 * provider's runs should say it in every provider's.
 */

/**
 * The most of a message body the model is shown. A routine about a mail needs
 * what the mail says, and a quoted thread underneath it is mostly what earlier
 * mails said; the run's own `MAX_MATERIAL_CHARS` is the ceiling, this is
 * what a reasonable reply is made from.
 */
export const MAX_BODY_CHARS = 6_000;

export function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lines with a value, joined — a missing field is left out, not "undefined". */
export function lines(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function clip(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[…cut at ${max} characters]` : text;
}
