import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A request's workspace is asked of `callerWorkspaceId`, and only it.
 *
 * `getActiveWorkspaceId` reads the owner's chosen workspace off their profile,
 * which is the right answer for a browser session and the wrong one for an API
 * key: a key acts in the workspace it was made in. Every route used to ask
 * `getActiveWorkspaceId` directly, so a key reached every
 * workspace its owner belonged to — and the fallback inside it wrote the
 * owner's profile on a script's behalf. One route calling it again directly is
 * the whole of that coming back, and nothing else would notice: a key and a
 * session look the same to every other test.
 */
const SRC = join(process.cwd(), "src");
const ALLOWED = new Set(["lib/workspace.ts"]);

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

/** Comments removed, so a sentence naming the function is not a call. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("which workspace a request acts in", () => {
  const files = sourceFiles(SRC);

  it("has a source tree to look at", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("lib/workspace.ts");
  });

  it("is asked of callerWorkspaceId everywhere but where it is defined", () => {
    const direct = files.filter(
      (f) =>
        !ALLOWED.has(f) &&
        codeOnly(readFileSync(join(SRC, f), "utf8")).includes("getActiveWorkspaceId("),
    );
    expect(
      direct,
      "these resolve a request's workspace from the owner's profile, which sends an API " +
        "key into whichever workspace its owner last chose. Ask callerWorkspaceId(c).",
    ).toEqual([]);
  });
});
