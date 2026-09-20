import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * A ratchet on the one import that cannot be in the Workers bundle.
 *
 * `workerd` has no DNS API and `nodejs_compat` does not supply one, so a static
 * `import … from "node:dns"` anywhere in the reachable graph fails
 * `wrangler deploy` — including `bun run dry`, which is where it would be
 * found. The current call site (`lib/routines/source.ts`) therefore reaches for
 * it through a dynamic `import()` behind a runtime check, and that shape is
 * load-bearing rather than stylistic.
 *
 * Other `node:` builtins are fine and are used: `nodejs_compat` provides
 * `node:fs`, `node:path` and `node:stream`, which is why `lib/docstore/fs.ts`
 * can import them at the top of the file. DNS is the exception, so DNS is what
 * is pinned.
 *
 * The second half of the ratchet is the runtime check itself. Deleting it costs
 * nothing on Workers — the import simply never runs there — and silently
 * disables the resolving half of the URL guard on Node, which is the runtime
 * that needs it, because Node's `fetch` resolves and connects to whatever DNS
 * returns on a network shared with the database. That failure is invisible
 * until someone points a routine at `169.254.169.254.nip.io`.
 */

/** Every source file under src/, excluding tests and their scaffolding. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (entry === "test-support") continue;
      out.push(...sourceFiles(full, rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

const SRC = import.meta.dirname;
const files = sourceFiles(SRC);
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/** `import … from "node:dns"` or `require("node:dns")` — the shapes that bundle. */
const STATIC_DNS = /(?:from\s*|require\(\s*)["']node:dns(?:\/promises)?["']/;

/** `import("node:dns")` — the shape that does not. */
const DYNAMIC_DNS = /import\(\s*["']node:dns(?:\/promises)?["']\s*\)/;

const WORKERS_CHECK = /navigator\.userAgent === "Cloudflare-Workers"/;

describe("the Workers bundle", () => {
  it("has a source tree to look at", () => {
    // Without this, a bad path would make every assertion below pass on nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("lib/routines/source.ts");
  });

  it("pulls in node:dns from nowhere", () => {
    const offenders = files.filter((f) => STATIC_DNS.test(read(f)));

    expect(
      offenders,
      "these import node:dns statically, which workerd cannot provide: " +
        "`wrangler deploy` and `bun run dry` will both fail. Reach for it " +
        "through a dynamic import() behind the Workers check instead, the way " +
        "lib/routines/source.ts does.",
    ).toEqual([]);
  });

  it("still resolves DNS somewhere, behind the runtime check", () => {
    const resolvers = files.filter((f) => DYNAMIC_DNS.test(read(f)));

    // Not decoration: without a resolver, `assertFetchableUrl` is judging the
    // hostname string alone and a name that merely points at private space
    // walks past it.
    expect(
      resolvers.length,
      "nothing resolves DNS any more — the resolving half of the URL guard is " +
        "gone, and a hostname that points at a private address is no longer checked.",
    ).toBeGreaterThan(0);

    for (const file of resolvers) {
      expect(
        WORKERS_CHECK.test(read(file)),
        `${file} imports node:dns dynamically but no longer checks the runtime. ` +
          "On Workers the import throws; the check is what keeps this Node-only.",
      ).toBe(true);
    }
  });
});
