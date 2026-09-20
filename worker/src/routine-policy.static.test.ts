import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A row level security policy cannot be added to.
 *
 * Changing one means `drop policy` and `create policy` again, which means every
 * guard it already had has to be copied forward by hand. Forget one and nothing
 * fails: the policy still exists, still has its name, still refuses the obvious
 * things, and has quietly stopped refusing one that somebody thought about
 * carefully a year ago.
 *
 * That is not hypothetical. `routines_insert_own` has been written four times.
 * 0012 created it, 0019 reworked it when a delivery channel stopped belonging
 * to a workspace, 0047 added `routine_source_is_visible` so a routine could not
 * be pointed at another workspace's connection, and 0056 added the output
 * bundle guard — and 0056's first draft was built on 0012's text, which would
 * have deleted 0047's guard and reopened a cross-tenant read.
 *
 * So: for every policy the migrations define more than once, whatever the
 * earlier definitions referenced the last one has to reference too. References
 * are the helper functions and tables a policy names, which is a coarse measure
 * and the right one — it is exactly what disappears when a clause is dropped by
 * accident, and it does not care how the clause was worded.
 *
 * A deliberate removal is a line in `INTENTIONALLY_DROPPED` with the reason,
 * which is the point: dropping a guard should be a thing somebody wrote down.
 */
const MIGRATIONS = join(process.cwd(), "..", "supabase", "migrations");

/**
 * Helpers that ask at least what the thing they replaced asked.
 *
 * Most of the rewrites in this tree moved a check rather than removed one: an
 * inline `exists (select 1 from workspace_members ...)` became
 * `is_workspace_member(...)`, and in 0021 that in turn became
 * `can_write_in_workspace(...)`, which is the same question **and not a
 * viewer** — strictly narrower, so the policy got stronger. 0031 did the same
 * for sessions: the inline subquery over `chat_sessions` became
 * `session_is_visible(...)`, a SECURITY DEFINER helper so a policy on
 * `messages` does not re-enter `chat_sessions`' own RLS.
 *
 * Each line below is a claim that can be checked by reading the function: what
 * it asks covers what the names on the right asked. It is not a way to excuse a
 * guard that went missing — for that there is `INTENTIONALLY_DROPPED`.
 */
const SUBSUMES: Record<string, string[]> = {
  is_workspace_member: ["workspace_members"],
  can_write_in_workspace: ["workspace_members", "is_workspace_member"],
  session_is_visible: ["chat_sessions", "workspace_members", "is_workspace_member"],
};

/**
 * Guards a later migration removed on purpose, keyed `policy:reference`.
 *
 * Empty is the healthy state, and it is currently empty. An entry here is a
 * claim that a guard stopped being needed, and it should read like one.
 */
const INTENTIONALLY_DROPPED: Record<string, string> = {};

type Definition = { file: string; body: string };

/** Every `create policy` in the tree, in migration order, keyed by policy name. */
function definitions(): Map<string, Definition[]> {
  const found = new Map<string, Definition[]>();

  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");

    for (const match of sql.matchAll(/create policy "([a-z0-9_]+)"/g)) {
      const name = match[1];
      const from = match.index ?? 0;
      // A policy definition ends at the first `;` that closes it. Policies here
      // contain no string literals with semicolons in them, so the first one
      // after the start is the end of the statement.
      const end = sql.indexOf(";", from);
      const body = sql.slice(from, end === -1 ? sql.length : end);
      found.set(name, [...(found.get(name) ?? []), { file, body }]);
    }
  }

  return found;
}

/** The helper functions and tables a policy body names. */
function referencesIn(body: string): Set<string> {
  const refs = new Set<string>();
  for (const m of body.matchAll(/public\.([a-z0-9_]+)\s*\(/g)) refs.add(m[1]);
  for (const m of body.matchAll(/from public\.([a-z0-9_]+)/g)) refs.add(m[1]);
  return refs;
}

/**
 * Whether a policy that no longer names `ref` still asks what `ref` asked,
 * because something it does name covers it.
 *
 * Transitive, so a chain — `can_write_in_workspace` covering
 * `is_workspace_member` covering `workspace_members` — resolves without every
 * link being spelled out on every line.
 */
function stillAsked(ref: string, has: Set<string>): boolean {
  if (has.has(ref)) return true;

  const seen = new Set<string>();
  const queue = [...has];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const covered of SUBSUMES[name] ?? []) {
      if (covered === ref) return true;
      queue.push(covered);
    }
  }
  return false;
}

describe("policies that were rewritten", () => {
  const byName = definitions();

  it("found the migrations at all", () => {
    // Without this, a wrong path makes every assertion below pass on nothing.
    expect(byName.size).toBeGreaterThan(20);
    expect(byName.has("routines_insert_own")).toBe(true);
  });

  it("never quietly loses a guard an earlier version had", () => {
    const lost: string[] = [];

    for (const [name, versions] of byName) {
      if (versions.length < 2) continue;

      const latest = versions[versions.length - 1];
      const has = referencesIn(latest.body);

      const everHad = new Set<string>();
      for (const version of versions.slice(0, -1)) {
        for (const ref of referencesIn(version.body)) everHad.add(ref);
      }

      for (const ref of everHad) {
        if (stillAsked(ref, has)) continue;
        if (`${name}:${ref}` in INTENTIONALLY_DROPPED) continue;
        const first = versions.find((v) => referencesIn(v.body).has(ref))!;
        lost.push(
          `${name} referenced ${ref} in ${first.file} and no longer does ` +
            `(latest: ${latest.file})`,
        );
      }
    }

    expect(
      lost,
      "a policy is dropped and recreated rather than amended, so a rewrite has " +
        "to carry every guard forward. Add the guard back, or add a line to " +
        "INTENTIONALLY_DROPPED saying why it stopped being needed.",
    ).toEqual([]);
  });

  it("says why for each guard that was dropped on purpose", () => {
    for (const [key, reason] of Object.entries(INTENTIONALLY_DROPPED)) {
      expect(reason.length, `${key}'s reason is too short to be one`).toBeGreaterThan(30);
    }
  });
});
