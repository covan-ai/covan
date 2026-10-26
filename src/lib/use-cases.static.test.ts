import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dirname, path), "utf8");

/**
 * Names the module may say that only look like a catalogue operation: its
 * own imports. Anything else of that shape is an operation slug, which a
 * card must not name — which one applies depends on what the person
 * connected, and a made-up one is marked active and never runs.
 */
const OWN_NAMES = new Set(["FROM_THE_MAILBOX"]);

describe("the use-case catalogue's source", () => {
  it("names no Composio operation", () => {
    const found = (read("use-cases.ts").match(/\b[A-Z]{2,}(_[A-Z0-9]+){2,}\b/g) ?? []).filter(
      (name) => !OWN_NAMES.has(name),
    );
    expect(found).toEqual([]);
  });

  it("is not a sidebar page: the use cases live under Routines", () => {
    expect(read("../components/primary-nav.ts")).not.toContain("use-cases");
  });
});
