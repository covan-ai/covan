import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `security definer` function is callable by the internet until somebody says
 * it is not.
 *
 * Postgres grants EXECUTE on a new function to PUBLIC, every role inherits
 * PUBLIC, and PostgREST exposes `public` functions as RPC endpoints — so a
 * function that runs as its owner and forgets `revoke ... from public` is not
 * "missing hardening", it is an endpoint anyone holding the anon key can call.
 * The anon key ships in the browser bundle. 0043 wrote that sentence above
 * `claim_due_connections`, whose return type includes an encrypted OAuth token,
 * and 0058 wrote it again above `record_capability_call`, which writes rows
 * saying an agent may go ahead.
 *
 * For those two the grant is not a precaution around the security boundary, it
 * IS the security boundary — there is no policy underneath, because the caller
 * they exist for has no `auth.uid()`. Which means the only thing standing
 * between "the scheduler may claim work" and "anybody may claim work" is one
 * line in a migration that nothing fails without.
 *
 * Hence this file. `tests/rls/structure.test.ts` proves the same thing better,
 * against a real database — and needs Postgres, GoTrue and PostgREST up, which
 * this does not, for the same trade `scripts/check-rls.mjs` already makes.
 *
 * Two kinds of function are exempt, and neither is a judgement call:
 *
 *  - anything returning `trigger`, because Postgres refuses to call one
 *    directly ("trigger functions can only be called as triggers"), so there is
 *    no endpoint to close; and
 *  - the ones named in `CALLABLE` below, each of which is meant to be reachable
 *    by a signed-in client and says why.
 */
const MIGRATIONS = join(process.cwd(), "..", "supabase", "migrations");

/**
 * Functions a signed-in client is supposed to be able to execute.
 *
 * Two families, and the distinction is worth keeping in view because they are
 * safe for different reasons.
 *
 * The POLICY HELPERS have to be executable by `authenticated`: a row level
 * security policy is evaluated as the caller, so a policy naming
 * `is_workspace_member(...)` fails outright if the caller cannot run it. They
 * are `security definer` so that a policy on one table does not re-enter
 * another table's policies, and each returns a boolean about the caller's own
 * standing — calling one directly tells you something you could have worked out
 * by reading rows you can already see.
 *
 * The CLIENT RPCs are ordinary API surface that happens to need to step outside
 * the caller's rights for a moment: creating the workspace you are about to be
 * the first member of, accepting an invitation addressed to your email,
 * cascading a soft delete through rows the policy would consider separately.
 * Each does its own membership check first, and that check is the boundary.
 */
const CALLABLE: Record<string, string> = {
  // -- policy helpers ------------------------------------------------------
  is_workspace_member:
    "named by nearly every policy in the schema; a policy is evaluated as the caller, so revoking this would fail every read in the product.",
  is_workspace_admin: "the same, for the admin half of the same question.",
  can_write_in_workspace: "the same, and narrower: member or admin, not viewer.",
  session_is_visible:
    "named by the policies on `messages`, so they do not re-enter `chat_sessions`' own policies for every row.",
  shares_workspace:
    "named by the profile policies; answers whether two accounts have a workspace in common.",
  // `routine_source_is_visible` is NOT here, and 0047 says why in the function
  // itself: it has to run as the caller so its subquery is filtered by the
  // caller's own policies. As definer it would see every connection in the
  // database and answer true for all of them. It is therefore not a definer
  // function and this file has nothing to say about it.

  // -- client RPCs ---------------------------------------------------------
  create_workspace:
    "creating the workspace you are about to be the first member of. There is no membership to check against yet, which is exactly why it cannot be an ordinary insert.",
  accept_invitation:
    "accepting an invitation addressed to your email. It checks the token and the address itself; a policy could not, because you are not a member until it succeeds.",
  soft_delete_agent:
    "cascading a soft delete to the rows that hang off an agent, which policies would otherwise consider one at a time. Checks the caller may write in the workspace first.",
  soft_delete_bundle: "the same, for a bundle.",
  soft_delete_document: "the same, for a document.",
  restore_agent:
    "the other direction, and the reason it is a function: a restore has to decide which children were hidden BY this deletion and which were already hidden on their own.",
  restore_bundle: "the same, for a bundle.",
  restore_document: "the same, for a document.",
  workspace_trash:
    "lists what a restore would bring back, across several tables, with the same membership check each of those tables applies.",
  touch_session:
    "moving a session's `updated_at` when a message is posted. 0008 grants it to `authenticated` explicitly: it is one write to a row the caller can already see, and doing it as an ordinary update would need a column grant on a table whose policies are about visibility rather than freshness.",
  show_message_version:
    "promoting one edit of a message to the visible one. Touches sibling rows as a set, so it is one statement rather than a client-driven sequence.",
};

type Fn = { name: string; file: string; returnsTrigger: boolean };

/**
 * The migrations, with `--` comments removed.
 *
 * Not tidiness. These files carry more prose than SQL, and a test that reads
 * the prose is a test a sentence can satisfy: comment the revoke out, leave the
 * line where it is, and a scanner looking for the words finds them. The
 * stripping is what makes this read the schema rather than the argument for it.
 *
 * No statement in this tree has `--` inside a string literal, which is the
 * thing a one-line stripper gets wrong.
 */
function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS, name), "utf8").replace(/--[^\n]*/g, ""),
    }));
}

/**
 * Every `security definer` function the migrations define, by its last
 * definition — a function redefined later is only as safe as that last text,
 * and `create or replace` does not reset grants but does change what the body
 * does.
 */
function definerFunctions(): Map<string, Fn> {
  const found = new Map<string, Fn>();

  for (const { name: file, sql } of readMigrations()) {
    // Up to the body delimiter, which is where `security definer` and the
    // return type both live. Stopping there keeps a function whose BODY
    // mentions another function from being read as a definition of it.
    for (const m of sql.matchAll(
      /create (?:or replace )?function public\.([a-z_]+)\s*\([\s\S]*?\)\s*returns([\s\S]*?)\$\$/g,
    )) {
      const head = m[0];
      if (!/\bsecurity definer\b/i.test(head)) continue;
      found.set(m[1], {
        name: m[1],
        file,
        returnsTrigger: /^\s*trigger\b/i.test(m[2]),
      });
    }
  }

  return found;
}

/** Functions some migration revokes from PUBLIC. */
function revokedFromPublic(): Set<string> {
  const revoked = new Set<string>();

  for (const { sql } of readMigrations()) {
    for (const m of sql.matchAll(
      /revoke\s+(?:all|execute)[^;]*?on function public\.([a-z_]+)[^;]*?from([^;]*);/gi,
    )) {
      // `from public, anon, authenticated` is the house phrasing. Revoking
      // from the named roles alone is the mistake this test exists to catch:
      // they inherit PUBLIC, so it changes nothing.
      if (/\bpublic\b/i.test(m[2])) revoked.add(m[1]);
    }
  }

  return revoked;
}

describe("security definer functions", () => {
  it("are revoked from PUBLIC unless they are meant to be called", () => {
    const exposed: string[] = [];

    for (const fn of definerFunctions().values()) {
      if (fn.returnsTrigger) continue;
      if (fn.name in CALLABLE) continue;
      if (revokedFromPublic().has(fn.name)) continue;
      exposed.push(`${fn.name} (${fn.file})`);
    }

    expect(
      exposed.sort(),
      "PostgREST exposes public functions as RPC and Postgres grants EXECUTE " +
        "to PUBLIC by default, so each of these is callable with the anon key " +
        "that ships in the browser bundle. Add `revoke all on function ... " +
        "from public, anon, authenticated`, or a line in CALLABLE saying why " +
        "a signed-in client is supposed to reach it.",
    ).toEqual([]);
  });

  it("has no stale entry in CALLABLE", () => {
    const defined = definerFunctions();
    const stale = Object.keys(CALLABLE).filter((name) => !defined.has(name));

    expect(
      stale.sort(),
      "a name here that no migration defines is an exemption nobody can check",
    ).toEqual([]);
  });

  // The two the plan singles out, asserted by name rather than by rule. A
  // future rewrite of the rule above must not be able to quietly stop covering
  // the functions it was written for.
  it("revokes the ones whose grant is the whole boundary", () => {
    const revoked = revokedFromPublic();

    for (const name of ["claim_due_routines", "claim_due_connections", "record_capability_call"]) {
      expect(revoked.has(name), `${name} must be revoked from PUBLIC`).toBe(true);
      expect(name in CALLABLE, `${name} must never be exempted`).toBe(false);
    }
  });
});

/**
 * The one decision in 0058 that cannot be taken back.
 *
 * `connection_grants.mode` holds `ask` or `always`. It deliberately has no
 * `never`, because `never` is the absence of a row — and two ways to say no can
 * disagree, at which point some code has to pick a winner at the worst possible
 * moment.
 *
 * Adding the third value later is not a migration, it is a change in what every
 * existing install means by silence. This test does not make that impossible;
 * it makes it deliberate, which is the most a test can do about a product
 * decision.
 */
describe("no row means no", () => {
  it("keeps `mode` to the two values that are not `never`", () => {
    const problems: string[] = [];

    for (const { name: file, sql } of readMigrations()) {
      // Only inside `connection_grants`. `agents.mode` is a different column
      // with a different meaning, and a rule about one that quietly polices the
      // other is a rule nobody can read.
      const table = sql.match(
        /create table (?:if not exists )?public\.connection_grants \(([\s\S]*?)\n\);/,
      );
      const scoped = table?.[1] ?? "";
      for (const m of scoped.matchAll(/mode\s+text[^,]*check\s*\(\s*mode\s+in\s*\(([^)]*)\)/gi)) {
        const values = m[1]
          .split(",")
          .map((v) => v.trim().replace(/^'|'$/g, ""))
          .filter(Boolean)
          .sort();
        if (values.join(",") !== "always,ask") {
          problems.push(`${file}: mode in (${values.join(", ")})`);
        }
      }
    }

    expect(
      problems,
      "the absence of a grant is what `never` means. A storable `never` would " +
        "be a second representation of no, and the default a workspace has " +
        "today is the one that cannot be renegotiated later.",
    ).toEqual([]);
  });
});
