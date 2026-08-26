import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Every file in this directory has to be reachable from the app.
 *
 * 31 of 44 were not. `shadcn add` writes a component together with everything it
 * depends on, so reaching for one picks up others, and nothing ever noticed:
 * dead UI does not fail a build, a type check or a test. It just sits in a
 * repository strangers read, carrying dependencies somebody has to keep patched.
 *
 * The objection to deleting them was that each is one `shadcn add` away and a
 * component re-added next month arrives at a version that has drifted from the
 * rest. That is a real cost, and it is a cost of *drifting back*, not of
 * deleting — which is what this test is for. Adding a component and wiring it
 * up passes; adding one and forgetting fails here, the same week rather than a
 * year later.
 *
 * The walk matches the one that found them: roots are the components imported
 * from outside this directory, then follow imports within it. Tests are not
 * users — a component whose only importer is its own test is still dead.
 */

const UI = import.meta.dirname;
const SRC = join(UI, "..", "..");

const IMPORT = /from\s+"@\/components\/ui\/([a-z0-9-]+)"/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

function importsIn(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1]);
}

describe("src/components/ui", () => {
  it("has nothing in it that the app cannot reach", () => {
    const components = readdirSync(UI)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .map((f) => f.replace(/\.tsx$/, ""));

    const roots = new Set(
      sourceFiles(SRC)
        .filter((f) => !f.startsWith(UI) && !/\.test\.tsx?$/.test(f))
        .flatMap(importsIn),
    );

    const reachable = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (reachable.has(name)) continue;
      reachable.add(name);
      if (components.includes(name)) stack.push(...importsIn(join(UI, `${name}.tsx`)));
    }

    expect(components.filter((c) => !reachable.has(c))).toEqual([]);
  });
});
