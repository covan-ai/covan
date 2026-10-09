import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the one message that must never be inside the cached prefix.
 *
 * Anthropic bills a repeated prefix at a tenth of its price and charges a 1.25x
 * premium to write one, so a breakpoint placed on a message that changes every
 * turn is the worst of both: the premium is paid and nothing can ever read the
 * entry back. That is not hypothetical either — `lib/completion.ts` carries the
 * measurement from 2026-09-28, when the retrieved block leaked into the cached
 * system block and the next turn read zero of the 11,967 tokens the previous
 * one had written.
 *
 * `toAnthropicMessages` used to find the boundary by role: a mid-conversation
 * `system` message could only be retrieval. Finding 8 of the 2026-10-08 audit
 * moved that block to `user` so a document cannot speak as the operator — and
 * the inference broke in the quietest way available. Nothing failed. No test
 * turned red, because every cache test fed the adapter a `system` block that
 * production had stopped sending. The only symptom was the bill.
 *
 * So the flag that replaced the inference is pinned at the sites that set it.
 * A seventh assembly site that builds a prompt from a `ragBlock` and forgets
 * `volatile` would work perfectly, answer correctly, and quietly cost its own
 * users money — which is exactly why it is worth a test rather than a comment.
 */
const ROOTS = ["src", "eval"];

/** A message built out of a retrieval block — `{ role, content: …ragBlock }`. */
const BUILDS_FROM_RAG = /\{[^{}]*content:\s*[A-Za-z_.]*[rR]agBlock[^{}]*\}/g;

/** The flag that tells the Anthropic adapter where the repeating prefix ends. */
const MARKS_IT = "volatile";

/** Every source file under the roots, excluding tests and their scaffolding. */
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

const assemblies = ROOTS.flatMap((root) =>
  sourceFiles(join(process.cwd(), root)).flatMap((file) => {
    const source = readFileSync(join(process.cwd(), root, file), "utf8");
    return [...source.matchAll(BUILDS_FROM_RAG)].map((m) => ({
      where: `${root}/${file}`,
      literal: m[0].replace(/\s+/g, " "),
    }));
  }),
);

describe("the retrieved block in an assembled prompt", () => {
  it("was found at every site that builds one", () => {
    // Without this, a reformat that put the literal across braces would leave
    // the assertion below running over an empty list and reporting success.
    expect(assemblies.length).toBeGreaterThanOrEqual(6);
    expect(assemblies.map((a) => a.where)).toContain("src/routes/chat.ts");
    expect(assemblies.map((a) => a.where)).toContain("eval/harness.ts");
  });

  it("is marked volatile, so the cache breakpoint lands in front of it", () => {
    const unmarked = assemblies
      .filter((a) => !a.literal.includes(MARKS_IT))
      .map((a) => `${a.where}: ${a.literal}`);

    expect(
      unmarked,
      `these build a prompt message out of a retrieval block without ${MARKS_IT}: ` +
        "true. `toAnthropicMessages` then has nothing to tell it where the repeating " +
        "prefix ends, falls back to the turn before the question — which IS the block " +
        "— and asks Anthropic to cache this one question's excerpts at a 1.25x " +
        "premium, in an entry no later turn can read.",
    ).toEqual([]);
  });
});
