import { cap } from "./budget";

/**
 * Shrink a tool result before the cap has to cut it.
 *
 * `cap` is a blind slice: a 40,000-character GitHub tree arrives as the first
 * 12,000 characters of one, which is a list of files that stops mid-path. The
 * two things below make the difference between a result that fits and one that
 * is truncated, and neither needs to know which service answered.
 *
 * Toolkit-agnostic on purpose. `registry.ts` refuses per-service knowledge in
 * the harness, and this stays inside that rule: the base64 pair is a JSON
 * convention several services share, and a URL is a URL.
 */

/** Everything printable plus tab, newline and carriage return. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Whether decoded bytes are text a model can read rather than a file. */
function readableText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  const unprintable = text.match(UNPRINTABLE)?.length ?? 0;
  return unprintable / text.length <= 0.05 ? text : null;
}

/**
 * Bytes out of either base64 alphabet, or null if it is not base64 at all.
 *
 * **The URL-safe alphabet is handled since 2026-09-28 (#210), and before that it
 * was a silent miss.** `atob` rejects `-` and `_`, so a service that encodes with
 * RFC 4648 §5 — which GitHub, Google and anything putting a payload in a query
 * string all do — had its content left encoded, and the model spent OUTPUT tokens
 * decoding it by hand. That is the exact cost `compactForModel` exists to remove,
 * and it was being paid at the most expensive rate in the request.
 *
 * Padding is restored as well as the alphabet translated, because base64url
 * conventionally omits `=` and `atob` is entitled to refuse a length that is not
 * a multiple of four.
 *
 * Still returns null for anything that is not base64 — a caller uses that to
 * leave the field exactly as the service sent it.
 */
function decodeBase64(value: string): Uint8Array | null {
  try {
    const canonical = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = canonical + "=".repeat((4 - (canonical.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

type Json = unknown;

/**
 * A fresh object that cannot inherit, so a key called `__proto__` stays a key.
 *
 * `out[key] = …` on a plain `{}` with `key === "__proto__"` runs
 * `Object.prototype`'s setter instead of creating an own property, and
 * `JSON.stringify` then omits it — a config dump carrying that field would
 * lose it silently on the way to the model.
 */
function blank(): Record<string, Json> {
  return Object.create(null) as Record<string, Json>;
}

/**
 * Decode every `{content, encoding: "base64"}` pair, in place, once.
 *
 * Once matters: a decoded string is never re-parsed, so a file that itself
 * contains `"encoding": "base64"` cannot trigger a second pass.
 *
 * Reports whether it changed anything, because the caller must be able to hand
 * back the original bytes when it did not — see `compactForModel`.
 */
function decodePayloads(node: Json, touched: { changed: boolean }): Json {
  if (Array.isArray(node)) return node.map((child) => decodePayloads(child, touched));
  if (typeof node !== "object" || node === null) return node;

  const row = node as Record<string, Json>;
  const out = blank();
  for (const [key, value] of Object.entries(row)) out[key] = decodePayloads(value, touched);

  if (typeof out.content === "string" && out.encoding === "base64") {
    const bytes = decodeBase64(out.content);
    if (bytes) {
      const text = readableText(bytes);
      if (text === null) {
        // Nothing a model can read, and the size is the only useful fact left.
        out.content = `[binary, ${bytes.length} bytes]`;
      } else {
        out.content = text;
        out.encoding = "utf-8";
      }
      touched.changed = true;
    }
  }
  return out;
}

/**
 * A string that is nothing but a link.
 *
 * Anchored at both ends, and no whitespace allowed between them. A prefix
 * match would also take any text that merely STARTS with a link — an issue
 * whose description opens with the repro URL, a README whose first line is a
 * badge — and the model would then report the field as empty.
 */
const IS_URL = /^https?:\/\/\S*$/;

/** Every string value that is nothing but a URL, gone. */
function dropUrls(node: Json): Json {
  if (Array.isArray(node)) return node.map(dropUrls);
  if (typeof node !== "object" || node === null) return node;
  const out = blank();
  for (const [key, value] of Object.entries(node as Record<string, Json>)) {
    if (typeof value === "string" && IS_URL.test(value)) continue;
    out[key] = dropUrls(value);
  }
  return out;
}

const URLS_OMITTED = "\n\n[urls omitted to fit; ask for a field with `fields` if you need one]";

/**
 * `cap`'s own notice, measured rather than guessed.
 *
 * Its length depends on the two numbers inside it, so the only honest way to
 * reserve room for it is to ask `cap` for one. Measured at `max`, whose digit
 * count is an upper bound for any smaller budget — so this over-reserves by a
 * character or two at worst, never under.
 */
function capNoticeLength(text: string, max: number): number {
  return cap(text, max).length - Math.min(text.length, max);
}

export function compactForModel(body: string, max: number): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON, so there is nothing to shape. The cap is all there is.
    return cap(body, max);
  }

  const touched = { changed: false };
  const shaped = decodePayloads(parsed, touched);
  // Nothing to shape and nothing to cut: hand back the ORIGINAL bytes.
  // `JSON.parse` + `JSON.stringify` is not a round trip for numbers — an int64
  // record id comes back off by one and `1e400` comes back `null` — and a
  // result nobody needed to change must not be paraphrased.
  if (!touched.changed && body.length <= max) return body;

  const decoded = JSON.stringify(shaped);
  if (decoded.length <= max) return decoded;

  // Only now, and in this order: a url is the cheapest thing in a result to
  // lose — the model can ask for it again, and the notice below says so —
  // while a sha or a path is what the answer is made of.
  const withoutUrls = JSON.stringify(dropUrls(shaped));
  if (withoutUrls.length + URLS_OMITTED.length <= max) return withoutUrls + URLS_OMITTED;
  // Room for BOTH notices inside `max`. Appending them afterwards put the
  // result over the budget, and `loop.ts` then capped it a second time — which
  // cut off the one sentence that made the dropped urls recoverable and
  // reported the capped length as the original, telling the model a large
  // result was small.
  const room = Math.max(0, max - URLS_OMITTED.length - capNoticeLength(withoutUrls, max));
  return cap(withoutUrls, room) + URLS_OMITTED;
}
