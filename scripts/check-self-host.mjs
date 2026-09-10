#!/usr/bin/env node
/**
 * Boots the built self-host server and asks it for a few pages.
 *
 * This exists because #101 was invisible to everything else we run. Lint,
 * typecheck, 1,647 unit tests and the RLS suite were all green for nine days
 * while `.output/server/index.mjs` answered 500 on every route it had. Nothing
 * was wrong with any source file — the bug lived in how the bundler chunked
 * them, so the only test that could ever have caught it is one that runs the
 * artifact. There was no such test. There is now.
 *
 * What it does NOT do is build. CI builds in its own step so that a build
 * failure reads as a build failure, and so this script stays runnable against
 * an `.output/` you already have:
 *
 *   NITRO_PRESET=node-server bun run build
 *   node scripts/check-self-host.mjs
 *
 * `node-server` is the preset `Dockerfile.web` sets, which makes it the one
 * self-hosters actually run. The hosted site is built with
 * `cloudflare-module` and was unaffected throughout — checking the wrong one of
 * those two is most of how this survived as long as it did.
 *
 * Dependency-free, like the other scripts here.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(root, ".output/server/index.mjs");
const SSR_DIR = join(root, ".output/server/_ssr");

const PORT = Number(process.env.PORT ?? 3199);

/*
 * Four pages that render without a database.
 *
 * Deliberately not just `/`. The failure this guards against is a module-scope
 * throw during SSR, which takes down every route at once — but a future one
 * might not, and a single-route check would then report health it had not
 * measured. The two legal pages are static, and `/sign-in` is the first page a
 * new self-hoster sees, so between them they cover the paths somebody hits
 * before they have any data at all.
 */
const ROUTES = ["/", "/privacy", "/terms", "/sign-in"];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reports import cycles between the emitted SSR chunks.
 *
 * Only ever called when something has already failed, and only to explain it.
 * It is not an assertion: plenty of module cycles are harmless, and ESM is
 * specified to handle them. The one in #101 was fatal for a narrower reason —
 * the value crossing the back-edge was a `var` read during module evaluation,
 * so whichever side ran second saw it hoisted and still `undefined`.
 *
 * Printing the cycle turns "TypeError: __exportAll is not a function" from a
 * mystery into a diagnosis, which is the difference between an afternoon and
 * ten minutes for whoever meets this next.
 */
function cyclesBetweenChunks() {
  if (!existsSync(SSR_DIR)) return [];

  const imports = new Map();
  for (const file of readdirSync(SSR_DIR).filter((f) => f.endsWith(".mjs"))) {
    const source = readFileSync(join(SSR_DIR, file), "utf8");
    const targets = [...source.matchAll(/from\s*"\.\/([^"]+\.mjs)"/g)].map((m) => m[1]);
    imports.set(file, new Set(targets));
  }

  const found = [];
  for (const [file, targets] of imports) {
    for (const target of targets) {
      // Report each pair once: a↔b and b↔a are the same cycle.
      if (file < target && imports.get(target)?.has(file)) found.push(`${file} ↔ ${target}`);
    }
  }
  return found;
}

async function probe(path) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: "manual" });
  return response.status;
}

/** Resolves once the server answers at all, whatever it answers. */
async function waitForListening() {
  for (let waited = 0; waited < 30_000; waited += 250) {
    await wait(250);
    try {
      await probe("/");
      return true;
    } catch {
      // Connection refused: still starting.
    }
  }
  return false;
}

if (!existsSync(ENTRY)) {
  console.error(
    `✗ ${ENTRY} does not exist.\n` + `  Build first:  NITRO_PRESET=node-server bun run build`,
  );
  process.exit(1);
}

const server = spawn(process.execPath, [ENTRY], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

/*
 * Kept rather than streamed. A module-scope throw is printed by the server the
 * first time a request reaches it, and that text is the single most useful
 * thing to show when this fails — but printing it during a passing run would
 * bury the result in noise.
 */
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

let failed = false;
try {
  if (!(await waitForListening())) {
    console.error(`✗ the server never listened on ${PORT} within 30s`);
    failed = true;
  } else {
    for (const route of ROUTES) {
      const status = await probe(route);
      const ok = status >= 200 && status < 400;
      console.log(`${ok ? "✓" : "✗"} ${String(status)}  ${route}`);
      if (!ok) failed = true;
    }
  }
} finally {
  server.kill("SIGKILL");
}

if (failed) {
  console.error("\n--- what the server said ---");
  console.error(serverOutput.trim() || "(nothing)");

  const cycles = cyclesBetweenChunks();
  if (cycles.length > 0) {
    console.error(
      "\n--- circular imports between SSR chunks ---\n" +
        cycles.map((c) => `  ${c}`).join("\n") +
        "\n\n" +
        "  A cycle is not automatically a bug, but it is how #101 failed: a\n" +
        "  helper crossing the back-edge was read during module evaluation,\n" +
        "  while it was hoisted and still undefined. If the error above is\n" +
        '  "X is not a function" and X is defined in one of the files named\n' +
        "  here, that is the same shape. See the rolldownConfig comment in\n" +
        "  vite.config.ts.",
    );
  }
  process.exit(1);
}

console.log(`\n✓ the self-host build serves ${ROUTES.length} routes`);
