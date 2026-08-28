import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the two ways a request can step outside Row Level Security.
 *
 * Everything in tests/rls/ proves the policies do their job. Nothing proves the
 * routes still ask them to. `serviceClient()` bypasses RLS completely — that is
 * its purpose — so a route that quietly switches to it keeps working, keeps
 * passing every other test in this repo, and stops being scoped to the caller.
 * The failure is invisible until someone reads two workspaces' worth of data.
 *
 * So the call sites are pinned. Adding one is allowed; adding one *silently* is
 * not. A new entry here has to be argued for in review, with the reason written
 * down next to it — which is the whole mechanism.
 *
 * The list only ever shrinks. Every entry is a place the database could not be
 * the one deciding, and each should be revisited when that stops being true.
 */

/** Files permitted to touch `serviceClient`. */
const SERVICE_CLIENT_ALLOWLIST = new Map([
  ["lib/supabase.ts", "defines it — the one place the service key becomes a client"],
  [
    "routes/routines.ts",
    "delivery_channels has no INSERT policy: the row holds a secret the route encrypts, so the route decides what goes in it, not the database",
  ],
  [
    "routes/chat.ts",
    "writes assistant messages, which 0009_lock_assistant_messages deliberately forbids the authenticated caller from writing",
  ],
  [
    "lib/routines/dispatcher.ts",
    "the scheduled Worker runs on a cron with no caller, so there is no JWT for RLS to resolve",
  ],
  [
    "lib/api-keys.ts",
    "authentication, the same exemption authClient has: an API key is looked up before there is a caller for RLS to resolve, so there is no user client to do it with — it reads one row by hash and writes that row's last_used_at, and nothing else",
  ],
]);

/**
 * Files permitted to name the service key itself.
 *
 * The first gate only sees `serviceClient`. It is blind to a route that builds
 * its own client straight from the binding, which is the same bypass by another
 * road — so the key gets a gate of its own.
 */
const SERVICE_KEY_ALLOWLIST = new Map([
  ["types.ts", "declares the binding"],
  ["lib/env.ts", "checks it is present at boot"],
  ["lib/supabase.ts", "the only consumer"],
]);

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

// Worker tests run with the worker directory as cwd, the way routes.test.ts
// resolves its own path on the frontend side.
const SRC = `${process.cwd()}/src`;
const files = sourceFiles(SRC);

function mentions(file: string, needle: string): boolean {
  return readFileSync(join(SRC, file), "utf8").includes(needle);
}

describe("the RLS bypass", () => {
  it("has a source tree to look at", () => {
    // Without this, a bad path would make every assertion below pass on nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("lib/supabase.ts");
  });

  it("is reached from no file that has not been argued for", () => {
    const unlisted = files.filter(
      (f) => mentions(f, "serviceClient") && !SERVICE_CLIENT_ALLOWLIST.has(f),
    );

    expect(
      unlisted,
      "these call serviceClient(), which skips RLS entirely. If that is genuinely " +
        "necessary, add the file to SERVICE_CLIENT_ALLOWLIST with the reason.",
    ).toEqual([]);
  });

  it("cannot be reconstructed from the raw key either", () => {
    const unlisted = files.filter(
      (f) => mentions(f, "SUPABASE_SERVICE_ROLE_KEY") && !SERVICE_KEY_ALLOWLIST.has(f),
    );

    expect(
      unlisted,
      "these name the service-role key, which is enough to build a client that " +
        "bypasses RLS without going through serviceClient().",
    ).toEqual([]);
  });

  it.each([...SERVICE_CLIENT_ALLOWLIST.keys()])(
    "still needs its exemption for serviceClient: %s",
    (file) => {
      // An exemption outliving its reason is how a list like this rots. If the
      // file stopped using it, the entry goes.
      expect(files, `${file} is allowlisted but no longer exists`).toContain(file);
      expect(
        mentions(file, "serviceClient"),
        `${file} no longer uses serviceClient — remove it from SERVICE_CLIENT_ALLOWLIST`,
      ).toBe(true);
    },
  );

  it.each([...SERVICE_KEY_ALLOWLIST.keys()])(
    "still needs its exemption for the key: %s",
    (file) => {
      expect(files, `${file} is allowlisted but no longer exists`).toContain(file);
      expect(
        mentions(file, "SUPABASE_SERVICE_ROLE_KEY"),
        `${file} no longer names the key — remove it from SERVICE_KEY_ALLOWLIST`,
      ).toBe(true);
    },
  );
});
