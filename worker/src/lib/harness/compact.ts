import { htmlToText } from "../formats/read/text";
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

/**
 * The headers of a message a person would read off it.
 *
 * Everything else in a mail header list is transport: `Received` hops,
 * `DKIM-Signature`, `ARC-*`, `Authentication-Results`, `X-*`. On 2026-10-01
 * `GMAIL_FETCH_EMAILS` with `max_results: 30` came back as the header list of
 * ONE message and part of a second, because those headers alone are 10,000
 * characters a message — and `format: "metadata"` on a single message hit the
 * cap the same way. All seven turns on record that read mail ended at the
 * token ceiling, re-asking for what the cap had cut.
 */
const READABLE_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
]);

/**
 * `[{name, value}, …]` that is a mail header list, not any list of pairs.
 *
 * Recognised by carrying a header only mail has, so a service's own
 * name/value settings list is left alone. Gmail's `payload.headers` and
 * Outlook's `internetMessageHeaders` both have this shape.
 */
function isMailHeaders(node: Json[]): boolean {
  if (node.length === 0) return false;
  let mail = false;
  for (const item of node) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const { name, value } = item as Record<string, Json>;
    if (typeof name !== "string" || typeof value !== "string") return false;
    if (/^(received|dkim-signature|arc-|authentication-results|return-path)/i.test(name)) {
      mail = true;
    }
  }
  return mail;
}

const BASE64URL = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A MIME part's declared type, lowercased, or null if this is not a part. */
function mimeTypeOf(node: Json): string | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const type = (node as Record<string, Json>).mimeType;
  return typeof type === "string" ? type.toLowerCase() : null;
}

/**
 * Mail, shaped for reading: transport headers gone, bodies decoded, HTML parts as text.
 *
 * A MIME part is `{mimeType, body: {data}}` with the data in base64url — the
 * Gmail API's own shape, and RFC 2045's tree under it. Left as it came, the
 * model is handed a message twice (the text, then the same text again as
 * HTML) in an alphabet it cannot read. So a text part is decoded, an HTML
 * part becomes text, an `alternative` that carries a plain part loses its
 * HTML twin, and anything that is not text is reduced to its size — the
 * attachment's id and filename stay, which is what fetching it needs.
 *
 * Still toolkit-agnostic in the sense this file means: it keys on the shape
 * of a message, which Gmail, Outlook and any IMAP bridge share, never on the
 * name of the service that sent it.
 */
function shapeMail(node: Json, touched: { changed: boolean }): Json {
  if (Array.isArray(node)) {
    if (isMailHeaders(node)) {
      touched.changed = true;
      return node.filter((h) =>
        READABLE_HEADERS.has(String((h as Record<string, Json>).name).toLowerCase()),
      );
    }
    const shaped = node.map((child) => shapeMail(child, touched));
    const hasPlain = shaped.some((part) => mimeTypeOf(part) === "text/plain");
    if (!hasPlain) return shaped;
    // An HTML part with a filename is an attached .html file, not the twin.
    const kept = shaped.filter(
      (part) =>
        mimeTypeOf(part) !== "text/html" || Boolean((part as Record<string, Json>).filename),
    );
    if (kept.length !== shaped.length) touched.changed = true;
    return kept;
  }
  if (typeof node !== "object" || node === null) return node;

  const out = blank();
  for (const [key, value] of Object.entries(node as Record<string, Json>)) {
    out[key] = shapeMail(value, touched);
  }
  const type = mimeTypeOf(out);
  const body = out.body;
  if (type && typeof body === "object" && body !== null && !Array.isArray(body)) {
    const data = (body as Record<string, Json>).data;
    // Strictly the alphabet: a body some bridge already decoded is prose, and
    // `atob` will happily turn a word of it into bytes.
    const bytes = typeof data === "string" && BASE64URL.test(data) ? decodeBase64(data) : null;
    const isText = type.startsWith("text/");
    const text = bytes && isText ? readableText(bytes) : null;
    // A text part that does not decode to text is left as it came, never sized.
    if (bytes && (text !== null || !isText)) {
      const decoded = blank();
      Object.assign(decoded, body);
      if (text === null) decoded.data = `[binary, ${bytes.length} bytes]`;
      else decoded.data = type === "text/html" ? htmlToText(text) : text;
      out.body = decoded;
      touched.changed = true;
    }
  }
  return out;
}

/**
 * Every string that is a whole HTML document, as its text.
 *
 * Except a file `decodePayloads` just opened: somebody who asked for
 * `index.html` by name asked for the markup, and gets it.
 */
function htmlAsText(node: Json, touched: { changed: boolean }): Json {
  if (typeof node === "string") {
    if (!isHtmlDocument(node)) return node;
    touched.changed = true;
    return htmlToText(node);
  }
  if (Array.isArray(node)) return node.map((child) => htmlAsText(child, touched));
  if (typeof node !== "object" || node === null) return node;
  const row = node as Record<string, Json>;
  const isFile = row.encoding === "utf-8" && typeof row.content === "string";
  const out = blank();
  for (const [key, value] of Object.entries(row)) {
    out[key] = isFile && key === "content" ? value : htmlAsText(value, touched);
  }
  return out;
}

/** A string that is an HTML document or an HTML email, not prose with a tag in it. */
function isHtmlDocument(text: string): boolean {
  if (text.length < 200) return false;
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return true;
  // HTML mail often arrives without the wrapper: a table or div soup. Count tags.
  const tags = text.match(/<\/?(div|table|tr|td|p|span|br|a|img|style|font|center)\b/gi)?.length;
  return (tags ?? 0) >= 10 && head.startsWith("<");
}

/**
 * Every long string shortened to the same length, so every item gets a share.
 *
 * `cap` keeps the first N characters, and on a list that is the first item:
 * twenty emails came back as most of one email and nothing of the other
 * nineteen, so the model fetched again, and again — on 2026-10-01 that was
 * eleven Gmail calls and 300,000 prompt tokens to read one sender's mail. A
 * list where every item is there, each cut short, answers "what came in" in
 * one call and says which one to open next.
 *
 * Finds the longest length every string may keep and still fit, by bisection:
 * each guess is serialised and measured, because JSON escaping makes a
 * character count of the strings alone a guess.
 */
const SHORTENED = "…";

/**
 * Only text is shortened: a string with no space in it is an id, a page token
 * or a hash, and half of one is worth less than none — the next call sends it
 * back and fails, or worse, pages from the wrong place.
 */
function isProse(text: string): boolean {
  return /\s/.test(text);
}

/**
 * Longer than any id or page token a service hands out, so a string past this
 * with no space in it is a blob: an inline image, an encoded attachment, a
 * tracking link the length of a page. Exempting those as if they were ids is
 * what let one mail of them hold a whole list over the budget, and the list
 * then fell through to `cap` and came back as its first item — measured
 * 2026-10-20 on the first pilot mailbox read after #365, at 12,054 characters
 * twice in a row. Half of a blob is worth nothing either, so it is not cut but
 * left out, with its size.
 */
const BLOB_CHARS = 1_000;

function isBlob(text: string): boolean {
  return text.length > BLOB_CHARS && !isProse(text);
}

function shorten(node: Json, limit: number): Json {
  if (typeof node === "string") {
    if (isBlob(node)) return `[${node.length} characters with no spaces, left out]`;
    return node.length > limit && isProse(node) ? `${node.slice(0, limit)}${SHORTENED}` : node;
  }
  if (Array.isArray(node)) return node.map((child) => shorten(child, limit));
  if (typeof node !== "object" || node === null) return node;
  const out = blank();
  for (const [key, value] of Object.entries(node as Record<string, Json>)) {
    out[key] = shorten(value, limit);
  }
  return out;
}

function longestString(node: Json): number {
  if (typeof node === "string") return isProse(node) || isBlob(node) ? node.length : 0;
  if (typeof node !== "object" || node === null) return 0;
  let longest = 0;
  for (const value of Object.values(node as Record<string, Json>)) {
    longest = Math.max(longest, longestString(value));
  }
  return longest;
}

/**
 * Below this a shortened field is a fragment nothing can be read from, so a
 * result that needs it falls through to `cap` instead.
 */
const MIN_SHARE = 120;

function fairShare(node: Json, max: number): string | null {
  let lo = MIN_SHARE;
  let hi = longestString(node);
  if (hi <= lo) return null;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = JSON.stringify(shorten(node, mid));
    if (text.length <= max) {
      best = text;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** The largest array in a result, by how much of it it is: the list to cut. */
function largestArray(
  node: Json,
  path: (string | number)[] = [],
): { path: (string | number)[]; items: Json[]; size: number } | null {
  if (typeof node !== "object" || node === null) return null;
  let best: { path: (string | number)[]; items: Json[]; size: number } | null = null;
  if (Array.isArray(node) && node.length > 1) {
    best = { path, items: node, size: JSON.stringify(node).length };
  }
  const entries: [string | number, Json][] = Array.isArray(node)
    ? node.map((child, i) => [i, child])
    : Object.entries(node as Record<string, Json>);
  for (const [key, child] of entries) {
    const found = largestArray(child, [...path, key]);
    if (found && (!best || found.size > best.size)) best = found;
  }
  return best;
}

function replaceAt(node: Json, path: (string | number)[], value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(node)) {
    return node.map((child, i) => (i === head ? replaceAt(child, rest, value) : child));
  }
  const out = blank();
  for (const [key, child] of Object.entries(node as Record<string, Json>)) {
    out[key] = key === head ? replaceAt(child, rest, value) : child;
  }
  return out;
}

/**
 * The first items of the result's main list that fit, with every text in them
 * at the shortest share — the last thing before a blind cut, and better than
 * one because it stops between two items rather than inside one, and says how
 * many it showed. Null when not even one item fits.
 */
function firstItemsThatFit(node: Json, max: number): string | null {
  const list = largestArray(node);
  if (!list) return null;
  const total = list.items.length;
  const fitted = (k: number) => {
    const notice = `\n\n[showing the first ${k} of ${total} items; ask for fewer, or a narrower range, for the rest]`;
    return JSON.stringify(replaceAt(node, list.path, list.items.slice(0, k))) + notice;
  };
  let lo = 1;
  let hi = total - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = fitted(mid);
    if (text.length <= max) {
      best = text;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * What a result that reached the blind cut was made of — counts and lengths,
 * never content. It is the only trace a cut leaves: `message_steps` keeps the
 * first two thousand characters of what the model saw, which shows that it was
 * cut and not why.
 */
function shapeOf(node: Json): Record<string, number> {
  const stats = { strings: 0, longestProse: 0, longestNoSpace: 0, longestList: 0 };
  const walk = (n: Json) => {
    if (typeof n === "string") {
      stats.strings += 1;
      if (isProse(n)) stats.longestProse = Math.max(stats.longestProse, n.length);
      else stats.longestNoSpace = Math.max(stats.longestNoSpace, n.length);
    } else if (Array.isArray(n)) {
      stats.longestList = Math.max(stats.longestList, n.length);
      n.forEach(walk);
    } else if (typeof n === "object" && n !== null) {
      Object.values(n as Record<string, Json>).forEach(walk);
    }
  };
  walk(node);
  return stats;
}

const SHORTENED_NOTICE =
  "\n\n[long text shortened to fit, each cut marked …; fetch one item by its id for all of it]";

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
  // Mail is shaped whatever its size. What goes is transport, markup and a
  // second copy of the same text, never something a person wrote, and a
  // ten-message list that fits at 11,000 characters is still re-sent on every
  // later pass of the turn.
  const shaped = htmlAsText(shapeMail(decodePayloads(parsed, touched), touched), touched);
  // Nothing to shape and nothing to cut: hand back the ORIGINAL bytes.
  // `JSON.parse` + `JSON.stringify` is not a round trip for numbers — an int64
  // record id comes back off by one and `1e400` comes back `null` — and a
  // result nobody needed to change must not be paraphrased.
  if (!touched.changed && body.length <= max) return body;

  const decoded = JSON.stringify(shaped);
  if (decoded.length <= max) return decoded;

  // Only now, and in this order: a url is the cheapest thing in a result to lose — the
  // model can ask for it again, and the notice below says so — while a sha or a
  // path is what the answer is made of.
  const linkless = dropUrls(shaped);
  const withoutUrls = JSON.stringify(linkless);
  const urlsNotice = withoutUrls.length < decoded.length ? URLS_OMITTED : "";
  if (withoutUrls.length + urlsNotice.length <= max) return withoutUrls + urlsNotice;
  // Then every item a share, rather than the first item all of it.
  const shared = fairShare(linkless, max - urlsNotice.length - SHORTENED_NOTICE.length);
  if (shared !== null) return shared + urlsNotice + SHORTENED_NOTICE;
  // Then as many whole items as fit, each at the shortest share.
  const listed = firstItemsThatFit(
    shorten(linkless, MIN_SHARE),
    max - urlsNotice.length - SHORTENED_NOTICE.length,
  );
  if (listed !== null) return listed + urlsNotice + SHORTENED_NOTICE;
  console.warn("tool result reached the blind cut", { chars: body.length, ...shapeOf(linkless) });
  // Room for BOTH notices inside `max`. Appending them afterwards put the
  // result over the budget, and `loop.ts` then capped it a second time — which
  // cut off the one sentence that made the dropped urls recoverable and
  // reported the capped length as the original, telling the model a large
  // result was small.
  const room = Math.max(0, max - URLS_OMITTED.length - capNoticeLength(withoutUrls, max));
  return cap(withoutUrls, room) + URLS_OMITTED;
}
