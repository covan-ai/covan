#!/usr/bin/env node
/**
 * Downloads the two web fonts into public/fonts/ and writes src/fonts.css.
 *
 * The site used to link fonts.googleapis.com from every page. That is two
 * extra connections (googleapis for the CSS, gstatic for the files) in front
 * of first paint, and the second one is not even discoverable until the first
 * has answered — a preconnect hides some of the cost but cannot remove the
 * serialisation. Self-hosting makes the fonts same-origin, so they ride the
 * connection the document already opened.
 *
 * The bigger reason is who else was on the request path. A page that fetches a
 * stylesheet from Google tells Google the address of everyone who opens it —
 * not our visitors on the hosted site, and not yours on a self-hosted one
 * either. On an install with no route out to the internet it is worse than a
 * disclosure: the request simply fails, and the whole interface renders in a
 * fallback face. Vendored fonts make an air-gapped Covan look like Covan.
 *
 * NOT wired into build or CI, and deliberately so — like scripts/check-sync.sh.
 * A build step that reaches out to a third party to fetch a binary is a build
 * that fails when that third party is down, and these files change roughly
 * never. Run it on a laptop when a family or a weight actually changes, and
 * commit what it writes.
 *
 * Dependency-free, like the other scripts in here.
 *
 *   node scripts/fetch-fonts.mjs
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = join(root, "public/fonts");
const CSS_OUT = join(root, "src/fonts.css");

/*
 * The exact query the old <link> in routes/__root.tsx used, so what gets
 * self-hosted is what the site was already loading — same families, same
 * weights, same italics. DM Sans carries an optical-size axis (9..40) and is
 * requested across it; Geist is upright only.
 *
 * If you add a weight to the design system, add it here and re-run.
 */
const GOOGLE_CSS =
  "https://fonts.googleapis.com/css2" +
  "?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;" +
  "1,9..40,400;1,9..40,500;1,9..40,600" +
  "&family=Geist:wght@400;500;600" +
  "&display=swap";

/*
 * Google returns different CSS to different browsers — an old user agent gets
 * .ttf and no unicode-range at all. Asking as a current Chrome is what gets
 * woff2 with the subset ranges intact.
 */
const MODERN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/*
 * Latin and its extension, and nothing else.
 *
 * Google's reply also carries Cyrillic, Cyrillic-ext and Vietnamese. Dropping
 * them costs nothing today — the interface is English (there is a test for it:
 * src/interface-language.static.test.ts) and so is every post — and each one
 * kept would be another file in the repo that no page ever requests.
 *
 * latin-ext is NOT optional despite that. It is the block holding ğ, ı, ş, ü,
 * ö and ç, and this is a product built by Turkish speakers: a member's name in
 * the team list or an author line in the frontmatter will reach for them. The
 * cost of keeping it is zero for readers who never hit those codepoints, since
 * unicode-range means the file is only fetched when a glyph in it is used.
 */
const SUBSETS = new Set(["latin", "latin-ext"]);

/** `DM Sans` + italic + `400 600` + latin → `dm-sans-400-600-italic-latin`. */
function fileNameFor({ family, style, weights, subset }) {
  const slug = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const span = weights[0] === weights[weights.length - 1] ? `${weights[0]}` : weights.join("-");
  return `${slug}-${span}${style === "italic" ? "-italic" : ""}-${subset}`;
}

/**
 * Collapses the weights that turned out to be the same file.
 *
 * Google's reply lists one @font-face per weight we asked for, but for a
 * variable family every one of them points at the *same* woff2 — the three DM
 * Sans weights came back byte-identical, and so did the three Geist ones.
 * Written out naively that is six downloads of two distinct files on an
 * English page, ~288 KB to deliver ~91 KB of font.
 *
 * So faces are grouped by what actually came down the wire (family, style,
 * subset and the bytes themselves) and each group becomes one @font-face with
 * a `font-weight` range covering its weights. A range is the correct
 * declaration for a variable font regardless; the deduplication is what makes
 * it worth doing.
 *
 * Grouping on the content hash rather than assuming variable-ness matters: a
 * family that really does ship one file per weight — or one that stops being
 * variable in a future release — simply forms one group per file and comes out
 * the far side unchanged, still correct.
 */
function mergeByFile(faces) {
  const groups = new Map();

  for (const face of faces) {
    // JSON.stringify rather than join(): a font family legitimately
    // contains a space ("DM Sans"), so a space-delimited key could in
    // principle be produced by two different tuples.
    const key = JSON.stringify([face.family, face.style, face.subset, face.hash]);
    const group = groups.get(key);
    if (group) {
      group.weights.push(Number(face.weight));
      continue;
    }
    groups.set(key, { ...face, weights: [Number(face.weight)] });
  }

  return [...groups.values()].map((group) => {
    const weights = [...group.weights].sort((a, b) => a - b);
    // The endpoints, not every weight in between: `400 600` is the range
    // syntax, and listing 400 500 600 would be a syntax error.
    return { ...group, weights: [weights[0], weights[weights.length - 1]] };
  });
}

/**
 * Splits Google's stylesheet into one record per @font-face.
 *
 * The subset name only exists as a `/* latin *\/` comment on the line above
 * each block — it is not a property — so the blocks are read in order and the
 * most recent comment is carried down onto the block that follows it.
 */
function parseFontFaces(css) {
  const faces = [];
  let subset = "unknown";

  const token = /\/\*\s*([a-z-]+)\s*\*\/|@font-face\s*\{([^}]*)\}/g;
  let match;
  while ((match = token.exec(css)) !== null) {
    if (match[1] !== undefined) {
      subset = match[1];
      continue;
    }

    const block = match[2];
    const value = (name) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

    const family = value("font-family")?.replace(/^['"]|['"]$/g, "");
    const url = block.match(/url\(([^)]+)\)/)?.[1]?.replace(/^['"]|['"]$/g, "");
    if (!family || !url) throw new Error(`a @font-face block had no family or no url:\n${block}`);

    faces.push({
      family,
      subset,
      url,
      style: value("font-style") ?? "normal",
      weight: value("font-weight") ?? "400",
      unicodeRange: value("unicode-range"),
    });
  }

  if (faces.length === 0) throw new Error("no @font-face blocks in Google's reply");
  return faces;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": MODERN_UA } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return response.text();
}

async function fetchBinary(url) {
  const response = await fetch(url, { headers: { "User-Agent": MODERN_UA } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/* -------------------------------------------------------------------- main */

const faces = parseFontFaces(await fetchText(GOOGLE_CSS)).filter((face) =>
  SUBSETS.has(face.subset),
);

if (faces.length === 0) {
  throw new Error(`Google returned no ${[...SUBSETS].join("/")} faces — did the query change?`);
}

// Downloaded before merging, because the merge keys on the bytes.
for (const face of faces) {
  face.data = await fetchBinary(face.url);
  face.hash = createHash("sha256").update(face.data).digest("hex");
}

const merged = mergeByFile(faces);

mkdirSync(FONT_DIR, { recursive: true });

let bytes = 0;
for (const face of merged) {
  face.file = `${fileNameFor(face)}.woff2`;
  writeFileSync(join(FONT_DIR, face.file), face.data);
  bytes += face.data.length;
}

/*
 * `font-display: swap` is carried through from Google's CSS rather than
 * dropped: text has to be readable in the fallback while the font arrives,
 * because the alternative is an invisible headline, and the headline here is
 * the LCP element's text.
 */
const css = `/*
 * Generated by scripts/fetch-fonts.mjs. Edit that, not this.
 *
 * DM Sans (display) and Geist (interface) are the two families named in
 * DESIGN.md §3.2, self-hosted so no page reaches a third party to paint.
 * Latin and latin-ext only; see the script for why.
 */

${merged
  .map(
    (face) => `@font-face {
  font-family: "${face.family}";
  font-style: ${face.style};
  font-weight: ${face.weights[0] === face.weights[1] ? face.weights[0] : face.weights.join(" ")};
  font-display: swap;
  src: url("/fonts/${face.file}") format("woff2");${
    face.unicodeRange ? `\n  unicode-range: ${face.unicodeRange};` : ""
  }
}`,
  )
  .join("\n\n")}
`;

writeFileSync(CSS_OUT, css);

console.log(
  `✓ ${merged.length} woff2 files (from ${faces.length} declarations) (${Math.round(bytes / 1024)} KB) in public/fonts/, ` +
    `src/fonts.css written`,
);
