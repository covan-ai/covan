#!/usr/bin/env node
/**
 * Draws public/og.png, the 1200x630 card every covan.app link unfurls as.
 *
 * The card had no source in this repo: it was a PNG that got repainted in place
 * whenever something on it changed, because the face it is set in (Geist) was
 * not vendored at the time. Both families now live in public/fonts, so the card
 * is a page again — written here in CSS with the app's own tokens and fonts,
 * photographed by headless Chrome. A browser is the thing on this machine that
 * is best at setting type, and it means editing a word on the card is editing a
 * word in this file.
 *
 * NOT wired into build or CI, for the same reason as scripts/fetch-fonts.mjs:
 * it needs a browser installed, which a build container has no business
 * requiring, and the card changes roughly never. Run it on a laptop when the
 * card's words or the brand change, commit the PNG, and bump the `?v=` on
 * og:image and twitter:image in src/routes/__root.tsx so the services that have
 * already scraped the old one fetch it again.
 *
 *   bun run og            (or: node scripts/generate-social-card.mjs)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "public/og.png");
const FONT_DIR = join(root, "public/fonts");

/** 1200x630 is what every scraper crops to, and what og:image:width declares. */
const WIDTH = 1200;
const HEIGHT = 630;

/*
 * Where Chrome tends to be. Firefox cannot screenshot a fixed viewport from the
 * command line the way `--screenshot` does, so this does not fall back to it.
 */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      "no Chrome or Chromium found. This script is laptop-only and needs one of:\n  " +
        CHROME_CANDIDATES.join("\n  "),
    );
  }
  return found;
}

/*
 * The mark, from src/assets/logo.svg. Copied rather than read so the card does
 * not depend on that file's comment staying out of the way of an inline <svg>;
 * if the logo is redrawn, redraw it here too.
 */
const MARK = `<polygon points="0,0 150,0 135.42,26.25 14.58,26.25"/>
  <polygon points="20.14,36.25 129.86,36.25 115.28,62.5 34.72,62.5"/>
  <polygon points="40.28,72.5 109.72,72.5 95.14,98.75 54.86,98.75"/>
  <polygon points="60.42,108.75 89.58,108.75 75,135"/>`;

/*
 * The card.
 *
 * Colours are the card's own: the canvas, ink, the muted ladder, and amber
 * spent exactly twice — the eyebrow and the one square bullet. The face is
 * Geist, the only family in DESIGN.md §3; the display jobs (wordmark,
 * headline) are told apart by size and weight alone.
 *
 * Positions are absolute, in pixels, because this is a picture with one size
 * and no reflow to plan for; each one was matched against the card it replaced.
 */
const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "Geist";
    font-style: normal;
    font-weight: 400 600;
    src: url("file://${FONT_DIR}/geist-400-600-latin.woff2") format("woff2");
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    overflow: hidden;
  }

  body {
    position: relative;
    background: #f7f7f4;
    color: #251f19;
    font-family: "Geist", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .abs { position: absolute; white-space: nowrap; }

  /* The display lines keep the platform's default smoothing; greyscale makes
     a 70px headline visibly thinner than it is on screen. */
  .display { -webkit-font-smoothing: auto; }

  /* The mark again, at 600px wide and bled off the right edge: a watermark
     one step off the canvas, never louder than the hairline drawn over it. */
  .watermark { left: 797px; top: 43px; width: 600px; height: 540px; fill: #ebeae8; }

  .tile {
    left: 88px; top: 76px; width: 52px; height: 52px;
    border-radius: 12px;
    background: #251f19;
    display: flex; align-items: center; justify-content: center;
  }
  .tile svg { width: 26px; height: 23.4px; fill: #f7f7f4; }

  .wordmark {
    left: 155px; top: 79px;
    font-family: "Geist", sans-serif;
    font-size: 36px; font-weight: 500;
    letter-spacing: -0.005em;
  }

  .eyebrow {
    left: 88px; top: 187px;
    font-family: "Geist", sans-serif;
    font-size: 17px; font-weight: 600;
    color: #f48d16;
  }

  h1 {
    left: 88px; top: 223px;
    font-family: "Geist", sans-serif;
    font-size: 70px; font-weight: 500;
    line-height: 78px;
  }
  h1 em { display: block; font-style: normal; font-weight: 400; letter-spacing: -0.003em; color: #948b81; }

  .lede {
    left: 88px; top: 404px;
    font-size: 20.75px;
    color: #5a524b;
  }

  .rule { left: 88px; top: 514px; width: 1050px; height: 2px; background: #e8e5e1; }

  .foot {
    left: 88px; top: 541px;
    display: flex; align-items: center;
    font-size: 15px;
    color: #79736c;
  }
  .foot .sq { width: 9px; height: 9px; background: #f48d16; margin-right: 11px; }
  .foot .sep { width: 5px; height: 5px; background: #c9c7c6; margin: 0 11px; }
  /* The one face not vendored. ui-monospace is SF Mono on a Mac, which is
     what the card has always been drawn with; elsewhere it falls back to the
     system's mono and the footer is merely set differently. */
  .foot code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; }
</style>
</head>
<body>
  <svg class="abs watermark" viewBox="0 0 150 135">${MARK}</svg>

  <div class="abs tile"><svg viewBox="0 0 150 135">${MARK}</svg></div>
  <div class="abs display wordmark">Covan</div>

  <div class="abs display eyebrow">Source available</div>
  <h1 class="abs display">The colleague who<em>has read everything.</em></h1>
  <p class="abs lede">Your team teaches it once; everyone gets their own private chat.</p>

  <div class="abs rule"></div>
  <div class="abs foot">
    <i class="sq"></i><span>FSL-1.1-ALv2</span>
    <i class="sep"></i><span>Self-hostable</span>
    <i class="sep"></i><code>docker compose up</code>
  </div>
</body>
</html>
`;

/* -------------------------------------------------------------------- main */

const chrome = findChrome();

/*
 * Chrome needs a profile directory it can write to, and the page has to live
 * somewhere; both go somewhere disposable so a failed run leaves nothing in
 * the repo.
 */
const scratch = join(tmpdir(), "covan-social-card");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const page = join(scratch, "card.html");
writeFileSync(page, PAGE);

/** Milliseconds, as a promise. */
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/*
 * Recent Chrome writes `--screenshot` and then does not exit, in any headless
 * mode, so waiting for the process means waiting forever. The file is the
 * signal instead: finished once its size stops changing between two polls,
 * because a PNG observed mid-write is a truncated PNG that still exists.
 */
rmSync(OUT, { force: true });
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    // Exactly 1200x630 pixels, whatever the display this runs on is.
    "--force-device-scale-factor=1",
    // The page paints its own canvas; this only matters if it ever fails to.
    "--default-background-color=f7f7f4ff",
    // Fonts are loaded from disk; without this Chrome treats each file:// read
    // as cross-origin and the card renders in a fallback face.
    "--allow-file-access-from-files",
    `--user-data-dir=${join(scratch, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Lets the web fonts finish loading before the frame is captured.
    "--virtual-time-budget=3000",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${OUT}`,
    `file://${page}`,
  ],
  { stdio: "ignore" },
);

try {
  let previous = -1;
  let done = false;
  for (let waited = 0; waited < 30_000 && !done; waited += 100) {
    await wait(100);
    const size = existsSync(OUT) ? statSync(OUT).size : -1;
    done = size > 0 && size === previous;
    previous = size;
  }
  if (!done) throw new Error("Chrome did not produce a screenshot within 30s");
} finally {
  // Chrome's helper processes can still be writing to the profile for a
  // moment after the kill, so a cleanup that loses that race only warns: the
  // card is already on disk by then.
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  }
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    console.warn(`could not clean up ${scratch}; it is safe to delete by hand`);
  }
}

console.log(`✓ public/og.png (${Math.round(statSync(OUT).size / 1024)} KB)`);
