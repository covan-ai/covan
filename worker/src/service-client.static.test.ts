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
    "delivery_channels has no INSERT policy: the row holds a secret the route encrypts, so the route decides what goes in it, not the database. The same column is why rotating a webhook's signing secret and sending a test both go this way — 0023 grants authenticated `update (label)` and no sight of secret_ciphertext at all, so neither reading the destination back nor writing a new secret over it is something a caller's own client can do. Both are scoped to `user_id = the caller` by hand, which is the job delivery_channels_select_own does everywhere else",
  ],
  [
    "routes/connections.ts",
    "connections has no INSERT grant and its secret_ciphertext is selectable by no client, for the reasons 0043 gives: the row holds an OAuth token this route encrypts before the database sees it, and the callback that writes it has no caller for RLS to resolve at all. Every claim in that callback's state is re-checked against workspace_members and knowledge_bundles before the insert, and the reads that decide permission everywhere else in the file go through the caller's own client",
  ],
  [
    "routes/slack.ts",
    "the same two reasons as routes/connections.ts, plus a third: an event delivered by Slack has no Covan caller at all, so RLS has nobody to resolve. What stands in for it is the signature (lib/slack/verify.ts) and the identity lookup in lib/slack/handle.ts, which answers as the Covan account matching the asker's email and as nobody otherwise",
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
    "lib/connections/dispatcher.ts",
    "the same exemption as the routine dispatcher, one floor up: a sync is claimed by a cron tick with no caller, so there is no JWT for RLS to resolve. What it may touch is bounded by hand in lib/connections/sync.ts, to the workspace and bundle that came out of claim_due_connections rather than out of anything a caller sent",
  ],
  [
    "lib/api-keys.ts",
    "authentication, the same exemption authClient has: an API key is looked up before there is a caller for RLS to resolve, so there is no user client to do it with — it reads one row by hash and writes that row's last_used_at, and nothing else",
  ],
  [
    "lib/purge.ts",
    "the thirty-day sweeper runs on the cron with no caller, so there is no JWT for RLS to resolve — the same exemption as the dispatcher. It is also the one thing that must see past the policies 0039 installed: every row it exists to delete is a row those policies hide from everybody, so a user client would find nothing to sweep and report success",
  ],
  [
    "routes/account.ts",
    "erasure is the one thing a caller cannot do as themselves: auth.users is outside RLS entirely, so deleting your own account needs auth.admin.deleteUser, and the workspaces left with nobody in them have no DELETE policy for the same reason nobody has ever needed one. Both writes are keyed to the caller's own id, and the survey that decides which workspaces those are is done through the user client on purpose",
  ],
  [
    "lib/routines/ingest.ts",
    "a POST from GitHub or a CI job carries no Covan session, so there is no auth.uid() for RLS to resolve — the same exemption routes/slack.ts holds. What stands in for a caller is the ingest token, and routine_triggers.token_hash is readable by no client role at all (0055), so the hash comparison could not be done with a user client even if there were one. It reads one row by hash, reads the routine that row names, and writes that routine's last_used_at; the route itself never names serviceClient, which is why the lookup lives here",
  ],
  [
    "lib/harness/secrets.ts",
    "the one place the agent harness reaches past RLS, and it never decides anything with it: every function there takes a row the caller has already been found — through their own client — to be allowed to have, and fills in the one column 0059 and 0012 withhold from every client role. Same shape and same order as withSecret in routes/connections.ts. The cache write is here for a second reason: 0059 grants `update (config)` only to the connection's creator or a workspace admin, which is the right rule for editing one and the wrong one for a summary nobody chose to cache",
  ],
  [
    "routes/tool-connections.ts",
    "tool_connections has no INSERT grant, for the reason 0059 gives and 0043 gave before it: the row holds a credential this route encrypts before the database sees it, so a client that could insert could insert a plaintext token — and the column grant means it could never read back what it wrote to check. Creation is the only write here that goes this way; the caller's own client does the permission check in front of it, and every other verb in the file goes through that client and its policies",
  ],
  [
    "routes/supabase-account.ts",
    "supabase_accounts has no INSERT and no UPDATE policy, for the reason 0061 gives: the row holds a Management API token this route encrypts before the database sees it, and no client role may select the column back. So storing a token and replacing one both go this way, and so does reading it back to ask Supabase which projects the account can see — the caller's own client answers the permission question first, every time, and the row it returned is what names the account this then reaches for. Connecting the projects themselves is the same insert tool_connections has always needed a service client for. Reading the account, listing it, and disconnecting it all go through the caller's client and its policies",
  ],
  [
    "lib/keys/store.ts",
    "workspace_provider_keys has RLS on and no policy for authenticated at all — not even a workspace's own admin selects a row. Every caller of this module is responsible for having checked who is asking before it does: routes/provider-keys.ts checks the admin role, and readWorkspaceKeys is read mid-chat-request for whoever the request already resolved to a member of",
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
