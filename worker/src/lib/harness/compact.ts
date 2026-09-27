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

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

type Json = unknown;

/**
 * Decode every `{content, encoding: "base64"}` pair, in place, once.
 *
 * Once matters: a decoded string is never re-parsed, so a file that itself
 * contains `"encoding": "base64"` cannot trigger a second pass.
 */
function decodePayloads(node: Json): Json {
  if (Array.isArray(node)) return node.map(decodePayloads);
  if (typeof node !== "object" || node === null) return node;

  const row = node as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(row)) out[key] = decodePayloads(value);

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
    }
  }
  return out;
}

const IS_URL = /^https?:\/\//;

/** Every string value that is a bare URL, gone. */
function dropUrls(node: Json): Json {
  if (Array.isArray(node)) return node.map(dropUrls);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(node as Record<string, Json>)) {
    if (typeof value === "string" && IS_URL.test(value)) continue;
    out[key] = dropUrls(value);
  }
  return out;
}

const URLS_OMITTED = "\n\n[urls omitted to fit; ask for a field with `fields` if you need one]";

export function compactForModel(body: string, max: number): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON, so there is nothing to shape. The cap is all there is.
    return cap(body, max);
  }

  const shaped = decodePayloads(parsed);
  const decoded = JSON.stringify(shaped);
  if (decoded.length <= max) return decoded;

  // Only now, and in this order: a url is the cheapest thing in a result to
  // lose — the model can ask for it again, and the notice below says so —
  // while a sha or a path is what the answer is made of.
  const withoutUrls = JSON.stringify(dropUrls(shaped));
  if (withoutUrls.length <= max) return withoutUrls + URLS_OMITTED;
  return cap(withoutUrls, max) + URLS_OMITTED;
}
