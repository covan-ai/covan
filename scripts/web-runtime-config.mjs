#!/usr/bin/env node
/**
 * Puts the real configuration into the built frontend when the container
 * starts.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, as literal strings in
 * the JavaScript the browser downloads. That is why there has never been a
 * publishable web image: whatever Supabase project was used to build it is
 * baked into the bundle, so the image only works for whoever built it, and
 * `docker compose up` had to compile the frontend on every machine.
 *
 * So the image is built against sentinel values, and this replaces them with
 * the environment's real ones before the server starts. One image, any
 * deployment.
 *
 * Two properties make it safe to do this to a compiled bundle:
 *
 *   - The originals are kept. Each file holding a sentinel is copied to
 *     `<file>.covan-tmpl` at build time and this reads from that copy, so a
 *     `docker restart` with different environment variables substitutes into a
 *     pristine bundle rather than into yesterday's substitution.
 *   - Nothing is left half-done. A required variable that is missing stops the
 *     container before the server binds, and a sentinel that survives
 *     substitution is an error rather than a frontend quietly pointed at a
 *     domain that does not resolve.
 *
 * The sentinels are `.invalid` hostnames on purpose: that TLD is reserved by
 * RFC 2606 and can never resolve, so a bundle that somehow escapes this script
 * fails visibly at the first request instead of reaching a real server.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

/** Build-time placeholder for each variable the browser bundle needs. */
export const SENTINELS = {
  VITE_SUPABASE_URL: "https://covan-sentinel-supabase-url.invalid",
  VITE_SUPABASE_ANON_KEY: "covan-sentinel-anon-key",
  VITE_API_URL: "https://covan-sentinel-api-url.invalid",
  VITE_TERMS_URL: "https://covan-sentinel-terms-url.invalid",
  VITE_PRIVACY_URL: "https://covan-sentinel-privacy-url.invalid",
};

/**
 * Without these the frontend cannot reach Supabase or the API, so there is
 * nothing for it to usefully do. The other two are links with built-in
 * fallbacks — see src/lib/legal.ts.
 */
const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_API_URL"];

/** Suffix of the pristine copy made at build time. */
export const TEMPLATE_SUFFIX = ".covan-tmpl";

export function resolveValues(env) {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Cannot start: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.\n` +
        "The web container needs these at run time — they are the addresses the\n" +
        "browser itself calls, so they must be reachable from the browser and not\n" +
        "from inside the compose network. See docs/self-hosting.md.",
    );
  }

  const values = {};
  for (const name of Object.keys(SENTINELS)) {
    // An unset optional variable becomes "", which src/lib/legal.ts reads as
    // "not configured" and answers with the built-in page.
    values[name] = env[name]?.trim() ?? "";
  }
  return values;
}

export function substitute(text, values) {
  let out = text;
  for (const [name, sentinel] of Object.entries(SENTINELS)) {
    // A function replacement, not a string one: `$&` and `$1` in a replacement
    // string are substitution patterns to String.replaceAll, and a URL with a
    // query string can contain them. The value has to arrive verbatim.
    out = out.replaceAll(sentinel, () => values[name]);
  }
  return out;
}

export function assertNothingLeftOver(text, file) {
  for (const [name, sentinel] of Object.entries(SENTINELS)) {
    if (text.includes(sentinel)) {
      throw new Error(
        `Cannot start: ${file} still contains the build-time placeholder for ${name}.\n` +
          "The image was built with a sentinel this script does not know about,\n" +
          "which means Dockerfile.web and scripts/web-runtime-config.mjs have\n" +
          "drifted apart. Serving this bundle would produce a frontend that\n" +
          "loads and cannot talk to anything.",
      );
    }
  }
}

/**
 * The etag nitro records for a public asset.
 *
 * Reproduces the `etag` package's format exactly — `"<hex length>-<27 chars of
 * base64 sha1>"` — because the value has to match what nitro would have written
 * for the substituted bytes, not merely be a valid etag. Verified against an
 * untouched entry in a real build.
 */
export function assetEtag(bytes) {
  const hash = createHash("sha1").update(bytes).digest("base64").substring(0, 27);
  return `"${bytes.length.toString(16)}-${hash}"`;
}

/**
 * Tell nitro the substituted files are the size they now are.
 *
 * This is the bug that made the whole idea not work, and it was invisible from
 * everything anyone would think to check. Nitro bakes a manifest of every public
 * asset — type, etag, mtime, **size** — into `.output/server/index.mjs` at build
 * time, and serves `Content-Length` from it. Substituting a 38-character
 * sentinel for a 21-character URL leaves the file 17 bytes shorter than the
 * manifest claims, so the browser receives fewer bytes than it was promised and
 * aborts the response with `ERR_CONTENT_LENGTH_MISMATCH`.
 *
 * The HTML document is unaffected — it holds no sentinels — so the page renders,
 * the health check passes, and the container is green. What fails is the
 * JavaScript: React never hydrates, and every button on the page does nothing.
 * A container that starts, serves pages and cannot sign anyone in, which is the
 * exact failure this script's header says it exists to prevent.
 *
 * Throwing when an entry is missing is the point. If a future nitro keeps this
 * manifest somewhere else, that has to fail loudly here rather than ship another
 * image that looks fine until somebody clicks something.
 */
export function updateAssetManifest(manifestText, entries) {
  let out = manifestText;

  for (const [urlPath, bytes] of entries) {
    const key = JSON.stringify(urlPath);
    const start = out.indexOf(`${key}: {`);
    if (start === -1) {
      throw new Error(
        `Cannot start: no manifest entry for ${urlPath}.\n` +
          "The server bundle records a size for every public asset and serves\n" +
          "Content-Length from it. Rewriting the file without correcting that\n" +
          "size produces a bundle the browser refuses to finish downloading, so\n" +
          "the page renders and nothing on it works. If nitro has moved this\n" +
          "manifest, this script has to move with it.",
      );
    }
    const end = out.indexOf("}", start);
    const before = out.slice(start, end);

    const updated = before
      .replace(/"size":\s*\d+/, `"size": ${bytes.length}`)
      .replace(/"etag":\s*"(?:[^"\\]|\\.)*"/, `"etag": ${JSON.stringify(assetEtag(bytes))}`);

    if (updated === before) {
      throw new Error(
        `Cannot start: manifest entry for ${urlPath} has no size or etag to correct.\n` +
          "Its shape is not what this script expects, and guessing would ship a\n" +
          "bundle that fails in the browser rather than here.",
      );
    }
    out = out.slice(0, start) + updated + out.slice(end);
  }

  return out;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * Build-time half: copy every file that carries a sentinel to `<file>.covan-tmpl`.
 *
 * It lives here rather than as a `grep` in the Dockerfile so the list of
 * sentinels exists in exactly one place. Two lists that have to agree is the
 * drift `assertNothingLeftOver` exists to catch, and not having two is better
 * than catching it.
 */
function prepare(root) {
  const sentinels = Object.values(SENTINELS);
  let count = 0;
  for (const file of walk(root)) {
    // JavaScript only. The sentinels are inlined by Vite into code, and reading
    // every font and image in .output/public as text to prove they are not
    // there is work with a known answer.
    if (!/\.m?js$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!sentinels.some((sentinel) => text.includes(sentinel))) continue;
    writeFileSync(`${file}${TEMPLATE_SUFFIX}`, text);
    count += 1;
  }
  if (count === 0) {
    throw new Error(
      `No sentinels found anywhere under ${root}.\n` +
        "Dockerfile.web builds with the sentinel values so this step can find\n" +
        "them; finding none means the build did not receive them, and the image\n" +
        "would carry whatever configuration the build machine had.",
    );
  }
  console.log(`covan: marked ${count} bundle file${count === 1 ? "" : "s"} as templates`);
}

function main() {
  if (process.argv[2] === "--prepare") {
    prepare(process.argv[3] ?? ".output");
    return;
  }

  const root = process.argv[2] ?? ".output";
  const values = resolveValues(process.env);

  const publicRoot = join(root, "public");
  const manifestPath = join(root, "server", "index.mjs");
  /** Public assets whose recorded size is now wrong. See updateAssetManifest. */
  const resized = [];

  let count = 0;
  for (const template of walk(root)) {
    if (!template.endsWith(TEMPLATE_SUFFIX)) continue;
    const target = template.slice(0, -TEMPLATE_SUFFIX.length);
    const rendered = substitute(readFileSync(template, "utf8"), values);
    assertNothingLeftOver(rendered, target);
    const bytes = Buffer.from(rendered, "utf8");
    writeFileSync(target, bytes);
    if (target.startsWith(publicRoot + sep)) {
      resized.push(["/" + relative(publicRoot, target).split(sep).join("/"), bytes]);
    }
    count += 1;
  }

  // After every substitution, never during: the manifest lives in the server
  // bundle, which may itself be one of the templates above and be restored from
  // pristine partway through the loop.
  if (resized.length > 0) {
    writeFileSync(manifestPath, updateAssetManifest(readFileSync(manifestPath, "utf8"), resized));
    console.log(`covan: corrected the recorded size of ${resized.length} asset(s)`);
  }

  // Zero is not "nothing needed doing", it is "the templates are not in this
  // image" — an image built without the build-time copy step. The bundle would
  // still hold sentinels and the server would start regardless.
  if (count === 0) {
    throw new Error(
      `Cannot start: no ${TEMPLATE_SUFFIX} files under ${root}.\n` +
        "This image was not built by Dockerfile.web, or its build-time copy step\n" +
        "did not run. The frontend it would serve is not configured.",
    );
  }
  console.log(`covan: configured ${count} bundle file${count === 1 ? "" : "s"}`);
}

// Only when run directly, so importing this from a test does not try to
// rewrite a build that is not there.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
