import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

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
    "lib/docs/enqueue.ts",
    "the one insert into document_jobs, which 0102 gives no client role a write on: a client that could write a job could put words in `sources` that every section is then written from, or name another workspace's bundle. It decides nothing a caller sent: before the insert, the bundle is checked writable and in the workspace, and the conversation is read, all through the caller's own client; the row is then written with exactly the workspace, agent, session and user those reads established",
  ],
  [
    "lib/docs/host.ts",
    "the document engine's clocks — the Durable Object's alarm, the Node timer, the cron — none of which has a caller, so there is no JWT for RLS to resolve. What each may touch is bounded to one job id: the one a route's own read returned when it kicked the host, or the one claim_due_document_jobs (0102, service role only) handed the cron",
  ],
  [
    "lib/indexing/host.ts",
    "the indexing job's clocks (0105) — the Durable Object's alarm, the Node timer, the cron — none of which has a caller, so there is no JWT for RLS to resolve. What each may touch is bounded to one document id: the one an upload or reindex route's own insert or read returned when it kicked the host, or one claim_due_index_jobs (0105, service role only) handed the cron",
  ],
  [
    "routes/document-jobs.ts",
    "stopping and retrying a document, and advancing it from the open tab when the deployment has no document host. 0102 gives document_jobs no client write grant, because every column is the worker's account of what it did with somebody's allowance. Every handler reads the job through c.get(\"db\") first — 0102's policy shows a job to its requester alone — and every write is then keyed to the row id that read returned, conditional on the status it was read in",
  ],
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
    "lib/routines/events/lifecycle.ts",
    "subscribing, unsubscribing and renewing a routine's event at its provider (0109). routine_event_subscriptions has no client write grant at all, and external_id and secret_ciphertext are readable by no client role — with one deployment-wide provider key the first is the whole address of the arrangement, and unsubscribing needs both. Every function takes one routine id: one the route has already shown is the caller's own through c.get(\"db\") (create, PATCH, DELETE, the event routes), or one claim_event_subscriptions (0109, service role only) handed the cron. Every read and write is keyed to that id, the routine row it names supplies the user and workspace an adapter is handed, and the connection an adapter subscribes with is the config.connectionId the route found through the caller's own client. subscriptionSetup opens one row's external_id and secret for GET /routines/:id/event/setup, which calls it only for a routine the caller owns, shown through their own client, in a session and never for an API key — a GitHub webhook's URL and secret, which the owner has to paste into the repository's settings",
  ],
  [
    "lib/routines/events/receive.ts",
    "a provider's delivery has no Covan caller, so there is no JWT for RLS to resolve — the same exemption lib/routines/ingest.ts holds for a webhook, one provider further away. What stands in for a caller is the receiving route's own verification of the provider's signature, which names one subscription. It reads that one row (by routine id or by the provider's own id for it), reads the routine it names with ingest.ts's column list, counts the event on that row through count_routine_event (0109, service role only), and hands the routine to runPokedRoutine, which re-checks membership and credits off the row as every run does",
  ],
  [
    "lib/routines/events/composio.ts",
    "the Composio event adapter (0109) subscribes with the connected account behind the connection a routine was set up with, and connected_account_id and composio_user_id are granted to no client role (0063) — on one deployment-wide Composio key the account id is the only thing separating two tenants. It reads only: the one tool_connections row named by the subscription's config.connectionId (which the route found through the caller's own client), re-checked against the routine's own workspace, its owner (or a workspace scope, 0098), its toolkit and its status before anything is subscribed; the other routine_event_subscriptions rows holding the same trigger instance id, so a shared instance is not ended under them; and, for a delivery matching no row, whether any Composio subscription is mid-subscribe. Every write stays in lifecycle.ts",
  ],
  [
    "lib/routines/events/slack.ts",
    "the Slack event adapter (0112) subscribes nothing at Slack, but has to check the install can hear what a routine asks for and find the channel it names, which takes the bot token — a column of slack_installations no client may read (0044). It reads only the one installation the route found through the caller's own client (config.connectionId), re-checked against the routine's own workspace, and writes nothing; every write stays in lifecycle.ts",
  ],
  [
    "lib/routines/poke-room.ts",
    "the Durable Object alarm a webhook's or an app event's run is moved into so it outlives the response has no caller, so there is no JWT for RLS to resolve. It reads one routines row, by the id the receiving route parked after ingest.ts or events/receive.ts had already resolved it with the service role, with ingest.ts's column list, skips it if it is deleted or no longer active, and hands it to runPokedRoutine, which re-checks membership and credits off the row as every run does. It writes nothing itself",
  ],
  [
    "lib/routines/held.ts",
    "a routine's report held for its browser (0100) is finished by whatever settled the browser's last task — a cron tick or an open tab answering for another person's run — so there is no caller whose JWT could resolve the routine, its channel or its run. routine_runs has no client write grant at all (0094), and routines.browser_conversation_id is the engine's column. Every read is keyed to the run id a browser task row carried and the routine row that run names: the channel is held to the routine's own user_id, the agent to the routine's workspace, and the conversation it opens is the routine owner's own, private, under the routine's agent",
  ],
  [
    "lib/browser/tasks.ts",
    "the one write `browse` makes, and it has to reach past RLS because 0073 gives browser_tasks no write grant to any client role — a client that could insert could name an arbitrary provider_task_id, and one deployment-wide BROWSER_USE_API_KEY means that id addresses somebody's running browser, whose output the poller would then deliver into the fabricator's conversation. Same shape and same reason as savePausedTurn in lib/harness/turn.ts. It decides nothing: every id it writes comes from ToolContext, which the route resolved from the authenticated request before the tool ran",
  ],
  [
    "lib/browser/sessions.ts",
    "the browser beside a conversation, and 0078 gives browser_sessions no write grant or policy for any client role, for two reasons. The first is a column: provider_session_id is readable by no client role at all, for connected_account_id's reason (0063, repeated by 0073 and 0077) — one deployment-wide BROWSER_USE_API_KEY makes it the entire address of a running browser, possibly signed into somebody's accounts — so the follow-up that continues it could not be issued with a user client even if there were one to issue it with. The second is live_state: `human` is the state in which the panel hands somebody the controls, and a client that could write it could put itself there while the agent was still typing. Same shape and same reason as lib/browser/tasks.ts, which it sits beside in the one call browse makes: it decides nothing, because the row is found by the chat session and user id ToolContext resolved from the authenticated request before the tool ran, and every later write — and the one read of browser_tasks, for a v4 run of that browser not yet settled, which browse refuses on before anything is charged — is keyed to the row id that read returned rather than to anything a caller sent",
  ],
  [
    "lib/browser/takeover.ts",
    "the writes behind a takeover, and 0077 gives neither browser_profiles nor browser_takeovers any write policy or write grant for any client role at all: the whole content of a profile row is an address at a third party, so a client that could write one could point its own row at somebody else's cookie jar — the same attack as reading provider_profile_id, through a different door. The two columns this module exists to handle are withheld from reading as well, for connected_account_id's reason (0063, repeated by 0073): one deployment-wide BROWSER_USE_API_KEY makes provider_profile_id and provider_session_id the entire address of somebody's jar and of a browser they are signed into right now, so neither the create nor the stop could be issued with a user client even if there were one to issue it with. Unlike lib/browser/tasks.ts it cannot claim that nothing caller-supplied reaches a predicate — POST /browser/takeovers/:id/close puts a takeover id in a URL path — so every mutation here is scoped to the caller's own user id as well as to the row, which is why somebody else's takeover answers exactly what an already-closed one answers, and the ids that are not scoped by it were read back out of a row that was. The route still resolves the caller and checks permission through c.get(\"db\") in front of all of it, and the one check that can still refuse — re-reading the original task when a takeover closes — is deliberately made with the caller's own client rather than this one, because that is the only client RLS can resolve a caller for and browser_takeovers.workspace_id exists so that read can fail for somebody who left the workspace mid-sign-in. Forgetting the jar (final-review I5) also reads the person's own browser_sessions rows — keyed to the user id the route resolved, never to anything a caller sent — refuses while one is `agent` or `human`, and clears provider_session_id and provider_browser_id (no client write grant, 0078) on the rest, narrowed to rows still `none`; and the first run's profile (runProfile, ruling R19) is ensureProfile's own claim-first write for the user ToolContext resolved",
  ],
  [
    "lib/browser/poller.ts",
    "the same exemption as the two dispatchers above, with two more of its own. A browser task is polled by a cron tick with no caller, so there is no JWT for RLS to resolve, and what the poll may touch is bounded by hand to the row that came out of claim_due_browser_tasks rather than to anything a caller sent. The first of its own is a column: browser_tasks.provider_task_id is readable by no client role at all (0073), for connected_account_id's reason — one deployment-wide BROWSER_USE_API_KEY means that id is the boundary between two tenants at the provider — so the poll could not be made with a user client even if there were one to make it with. The second is what it writes when a task ends: the answer goes into `messages` as an assistant row, which 0009_lock_assistant_messages deliberately forbids the authenticated caller from writing, which is routes/chat.ts's entry above arriving by a different road",
  ],
  [
    "lib/browser/sweep.ts",
    "the same exemption as the poller one floor up, with two of its own. An abandoned takeover is swept by a cron tick with no caller, so there is no JWT for RLS to resolve, and what the sweep may touch is bounded by hand to the row claim_due_browser_takeovers handed it rather than to anything a caller sent. The first of its own is a column: browser_takeovers.provider_session_id is readable by no client role at all (0077), for connected_account_id's reason — one deployment-wide BROWSER_USE_API_KEY means that id is the boundary between two tenants at the provider — so the stop could not be issued with a user client even if there were one to issue it with. The second is that 0077 grants no client role an update on browser_takeovers or browser_profiles either, because both rows are addresses at a third party and a client that could write one could point its own at somebody else's cookie jar. It decides nothing: the only row it writes is the one the claim function chose, and the only status it writes is the one the provider confirmed. The same file also sweeps the browser beside a conversation that somebody took over and never handed back (claim_due_browser_sessions, 0078), for the same reason and with the same bound: it has no caller, browser_sessions.provider_session_id and provider_browser_id are granted to no client role (0078) so the stop could not be issued with a user client, and browser_sessions.live_state is written by the worker alone because `human` is the state that hands somebody the controls. It reads browser_profiles.provider_profile_id (0077, no client role) to refresh the jar. Every write it makes is keyed to the row the claim returned and conditional on live_state still being `human`, so a person who pressed Done meanwhile is never overwritten. The same claim also hands it a browser nobody is using (ruling R20: live_state `none`, still naming a provider_browser_id, ten minutes after its last run), which it stops the same way; that write only clears provider_browser_id and the lease, and is conditional on live_state still being `none` and last_run_at unchanged, so a run that started meanwhile keeps its browser",
  ],
  [
    "lib/browser/settle.ts",
    "the one place a browser task goes from running to answered, for both of its callers — the cron poller above and the open tab's lib/browser/live.ts below — so it carries the poller's exemption and both of its own reasons: browser_tasks has no write grant for any client role (0073: a client that could write the row could invent an answer the agent would read back as fact), and the answer is an assistant message, which 0009_lock_assistant_messages forbids the authenticated caller from writing. It also writes browser_sessions.live_state, which 0078 lets no client role write because `human` is the state that hands somebody the controls. It decides nothing a caller sent: its first statement is the claim — update … where id = the row its caller resolved and status in ('queued','running') — and the browser it touches is the one the CLAIMED row names, not the one passed in, moved only from 'agent' to 'none'. When that row names no browser yet it records the one the provider lists as active for the session (provider_browser_id, granted to no client role), narrowed to a row still naming none — the idle sweep's marker (ruling R20)",
  ],
  [
    "lib/browser/queue.ts",
    "browser tasks waiting their turn (0080). It writes browser_tasks — a waiting row, its start (waiting to queued, naming the run), and its end when it is removed, given up on or expires — which 0073 gives no client role a write on, for the reason tasks.ts writes the row it does: a client that could write it could name somebody else's run. It calls claim_next_browser_tasks, which 0080 grants to the service role alone because it returns whole rows carrying provider ids. It starts a run from a cron tick and from a settle, with no caller and so no JWT for RLS to resolve, and it reads browser_sessions.provider_session_id and provider_browser_id (0078, no client role) to start it in the right browser. And it writes an assistant message — the notice that closing a browser took its waiting tasks out of the line — which 0009_lock_assistant_messages forbids the authenticated caller from writing. It decides nothing a caller sent: the rows it starts are the ones the claim chose, and every write is a compare-and-set on status = 'waiting' keyed to such a row, or to a task or browser a route already showed, through the caller's own client, to be the caller's",
  ],
  [
    "lib/browser/live.ts",
    "the open tab's clock behind GET /sessions/:id/browser-tasks. It reads browser_tasks.provider_run_id and browser_sessions.provider_browser_id and events_cursor, all granted to no client role (0073, 0078) for connected_account_id's reason — one deployment-wide BROWSER_USE_API_KEY makes a provider id the entire address of somebody's running browser — so the poll could not be made with a user client even if there were one to make it with, and it writes the cursor and the browser id back, which no client role may write either. The route reads the conversation through c.get(\"db\") first, so RLS decides whether the caller may see it at all; every read here is then narrowed by hand to that conversation AND the caller's own user id, so a colleague in a shared chat never polls or settles somebody else's browser, and every write is keyed to a row id those reads returned. What it answers is a DTO with no provider id in it — browserReady is a boolean, never the browser id. openBrowsersAmong (Task 3.2, ruling R48) is the same reading for Settings → Browser sign-ins' list of open browsers: GET /browser/sessions reads the caller's rows through c.get(\"db\") first, so RLS — the owner's policy, with its workspace half — decides which rows exist, and hands over only those ids; the one service-role read is then narrowed to those ids AND the caller's own user id, selects provider_browser_id only to answer whether it is set, writes nothing, and returns a set of Covan's own row ids",
  ],
  [
    "lib/browser/controls.ts",
    "the person's four moves on the browser beside a conversation — watch, take over, hand back, stop — behind routes/browser.ts's /browser/sessions/:id routes. Each one needs a column no client role may read: browser_sessions.provider_session_id and provider_browser_id (0078) to reach the browser at all, and browser_tasks.provider_run_id (0073, 0078) to cancel the agent's run, all withheld for connected_account_id's reason — one deployment-wide BROWSER_USE_API_KEY makes a provider id the entire address of somebody's running, possibly signed-in browser. And each one writes what 0078 lets no client role write: live_state, whose `human` is the state in which the panel hands somebody the controls, so a client that could set it could take a browser out of the agent's hands mid-type; the task's stop; and the hand-back's run, which is a browser_tasks row (no client write grant, 0073). It decides nothing a caller sent: every route reads the row through c.get(\"db\") first, so RLS — the owner's policy, which a colleague in the same shared chat does not satisfy — answers whether the caller may touch it, and every read and write here is then keyed to that row id AND the caller's own user id, because the id arrives in a URL path and this client answers to no policy. The original a hand-back continues is read by the route through the caller's own client too, which is what refuses a task somebody can no longer see. Nothing it returns carries a provider id; the one credential, liveUrl, is returned to its owner and written nowhere",
  ],
  [
    "lib/browser/credentials.ts",
    "the login you save (0079), and the one module that reads or writes browser_credentials. 0079 gives that table no write grant or write policy for any client role, because saving a login means encrypting it under ROUTINE_SECRET_KEY, which only the worker holds — a client that could insert could store a plaintext password in a column named ciphertext, and could never read it back to check, since neither username_ciphertext nor password_ciphertext is granted to any client role either. That second grant is also why the binding a run is given (credentialsFor, the only decrypt of a saved login in the product) cannot be read with a user client even if there were one. The route in front of a save or a forget has already asked, through c.get(\"db\"), whether the caller may use the agent; what this file asks with the service role is only what must not rest on the caller's word: that the agent is in the workspace the row will name (0079's read policy does not check it), whether a shared login's saver is still a member of the row's workspace before it is used (R29), and whether a forgetter is that workspace's admin (workspace_members.role, as 0003's is_workspace_admin decides it). Every read is narrowed to the caller's own row or to the one shared row for the agent and site, and every write and delete is keyed to a row id that read returned and repeats its own condition. Nothing it returns outside the SecretBinding[] carries either half of a login, and nothing it logs carries more than a row id and an error code",
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
    "lib/routines/address-confirmation.ts",
    "the person confirming an address may have no Covan account, so the link's token is the only credential, and delivery_channels.confirmation_hash is granted to no client role (0096). Every write is keyed to one channel id or one token hash; the owner's own address is read from auth.users through the admin API, which no client can reach, and the daily cap counts one owner's rows",
  ],
  [
    "lib/routines/ingest.ts",
    "a POST from GitHub or a CI job carries no Covan session, so there is no auth.uid() for RLS to resolve — the same exemption routes/slack.ts holds. What stands in for a caller is the ingest token, and routine_triggers.token_hash is readable by no client role at all (0055), so the hash comparison could not be done with a user client even if there were one. It reads one row by hash, reads the routine that row names, and writes that routine's last_used_at; the route itself never names serviceClient, which is why the lookup lives here",
  ],
  [
    "lib/harness/secrets.ts",
    "the one place the agent harness reaches past RLS, and it never decides anything with it: every function there takes a row the caller has already been found — through their own client — to be allowed to have, and fills in the columns 0059, 0012 and 0063 withhold from every client role. Same shape and same order as withSecret in routes/connections.ts. The cache write is here for a second reason: 0059 grants `update (config)` only to the connection's creator or a workspace admin, which is the right rule for editing one and the wrong one for a summary nobody chose to cache. 0063 adds a fourth column and it is not a secret — `connected_account_id` is Composio's opaque reference and the token it stands for never reaches this database — but one deployment-wide API key opens every workspace's accounts, so on that arrangement the id is the boundary and is withheld for the same reason",
  ],
  [
    "routes/composio.ts",
    "the same insert tool_connections has needed a service client for since 0059, with 0063's sharper reason: the row carries connected_account_id, which no client role may select, so a client that could insert could write another workspace's account id and — because of that same column grant — could never read back what it wrote to check. Settling a pending connection's status is the second one: `status` is granted to authenticated for reading only, because the state of somebody's half-finished consent flow is not a field a settings screen edits. Both are preceded by a permission check through the caller's own client, and every grant read and write in the file goes through that client and 0063's policies — including the one rule that needs an admin, which is a WITH CHECK rather than anything this route asks",
  ],
  [
    "routes/tool-connections.ts",
    "tool_connections has no INSERT grant, for the reason 0059 gives and 0043 gave before it: the row holds a credential this route encrypts before the database sees it, so a client that could insert could insert a plaintext token — and the column grant means it could never read back what it wrote to check. Creation is one of two writes here that go this way; the other is the read of connected_account_id before a Composio row is deleted, which no client role may select and which is the last moment the grant at the third party can be handed back (0063, lib/composio/revoke.ts). The caller's own client does the permission check in front of both, and every other verb in the file goes through that client and its policies",
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

/**
 * Files that never call `serviceClient()` but are handed the client it returns.
 *
 * The allowlist above sees the identifier and nothing else, so it was blind to
 * the far end of every exemption: a dispatcher builds the service client and
 * passes it on, and the function that receives it runs queries no policy
 * filters, from a file this test had never heard of. The ones known are
 * listed below. Each is listed with what bounds its queries in place
 * of the policies it does not get.
 *
 * The scan below finds a direct hand-over — `f(admin)`, `f({ db: admin })`,
 * `f(serviceClient(env))` — from a file that builds the client, and fails on a
 * receiver that is not here. It does not follow the client through a local
 * factory, so some of these are listed from reading rather than found by it.
 */
const RECEIVES_THE_SERVICE_CLIENT = new Map([
  [
    "lib/indexing/job.ts",
    "one unit of one document's indexing, for the clocks in lib/indexing/host.ts and the DocumentRoom alarm: every read and write is keyed to the document claim_index_job returned, its passages are written with that document's own bundle and its bundle's workspace_id, and the credits it spends are recorded against that workspace",
  ],
  [
    "lib/docs/engine.ts",
    "one unit of work on one document job, for the clocks in lib/docs/host.ts and the tab's poll: every read and write is keyed to the job claim_document_job returned, and the agent and bundle are read with that job's own workspace_id",
  ],
  [
    "lib/routines/address-confirmation.ts",
    "the channel routes hand it a service client for the 0096 bookkeeping on a channel the route has already scoped to the caller by user_id: the daily count is of that owner's rows, and the link update is keyed to that channel's id",
  ],
  [
    "lib/slack/handle.ts",
    "a Slack event has no Covan caller. Every query is scoped to the installation's workspace, and the asker is resolved to a member by email before anything is read on their behalf",
  ],
  [
    "lib/routines/events/slack-deliver.ts",
    "a Slack event has no Covan caller, the same exemption lib/slack/handle.ts holds beside it. It reads only routine_event_subscriptions rows for the team the signed delivery named (provider slack, external_id that team id, active, this event type and channel), and hands each routine id to receiveEvent, which re-reads it and applies every check a delivery gets — the routine running, its filters, the flood fuse — before the executor re-checks membership and credits",
  ],
  [
    "lib/routines/executor.ts",
    "a scheduled run has no caller. Every read is keyed to the routine row the claim returned and its own workspace_id, and the owner's membership is checked before a run",
  ],
  [
    "lib/routines/held.ts",
    "the executor hands it the run's service client to open the routine's conversation: the routine row it was given is the one the claim returned, and the conversation is opened for that row's owner, agent and workspace and no other",
  ],
  [
    "lib/routines/agent-run.ts",
    "the agent half of a scheduled run, with the executor's bounds: the routine's own workspace and agent",
  ],
  [
    "lib/routines/filing.ts",
    "files a summary into the routine's output bundle, verified against the routine's workspace before the insert; retention is held to that workspace too",
  ],
  [
    "lib/routines/connection-source.ts",
    "reads one connection's documents for a routine, the connection and every document held to the routine's own workspace",
  ],
  [
    "lib/retrieval.ts",
    "retrieval for Slack and scheduled runs: scoped to the bundles attached to an agent the caller already resolved, and to documents not in the bin",
  ],
  [
    "lib/connections/sync.ts",
    "a sync has no caller: bounded to the connection claim_due_connections returned, its bundle, its workspace, and a holder who is still a member",
  ],
  [
    "lib/connections/holder.ts",
    "one read of workspace_members, keyed to the connection's own workspace and holder",
  ],
  [
    "lib/connections/release.ts",
    "account closure: reads and clears only connections whose user_id is the person closing their own account",
  ],
  [
    "lib/composio/revoke.ts",
    "account closure and connection removal: reads connected_account_id, which no client role may, for rows the caller was already shown to be allowed to remove",
  ],
  [
    "lib/harness/turn.ts",
    "parks and resumes a turn: paused_turns has no client write grant, and every row is keyed to a message and session the route resolved through the caller's own client",
  ],
  [
    "routes/chat-turn.ts",
    "salvages a reply after a failure: writes the assistant message 0009 forbids the caller to write, into the session the route already resolved",
  ],
]);

function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Top-level arguments of a call, given the text between its parentheses. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/** The source files a file hands the service client to, directly. */
function handsTheClientTo(file: string): string[] {
  const code = codeOnly(readFileSync(join(SRC, file), "utf8"));
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(" as ").pop()!.trim();
      if (name) imports.set(name, m[2]);
    }
  }
  const found = new Set<string>();
  // One top-level unit at a time — a handler, a function — so a name used for
  // the service client in one does not taint the same name in another.
  for (const unit of code.split(/\n(?=[A-Za-z])/)) {
    if (!unit.includes("serviceClient(")) continue;
    const held = new Set(
      [...unit.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*serviceClient\(/g)].map((m) => m[1]),
    );
    const holds = (arg: string) =>
      arg.startsWith("serviceClient(") ||
      held.has(arg) ||
      (arg.startsWith("{") &&
        ([...held].some((v) => new RegExp(`(?:\\w+\\s*:\\s*|[{,]\\s*)${v}\\s*[,}]`).test(arg)) ||
          /:\s*serviceClient\(/.test(arg)));
    for (const m of unit.matchAll(/\b(\w+)\(/g)) {
      const from = imports.get(m[1]);
      if (!from || !from.startsWith(".")) continue;
      let depth = 1;
      let j = (m.index ?? 0) + m[0].length;
      const start = j;
      while (j < unit.length && depth > 0) {
        if (unit[j] === "(") depth++;
        else if (unit[j] === ")") depth--;
        j++;
      }
      if (!splitArgs(unit.slice(start, j - 1)).some(holds)) continue;
      const target = normalize(join(dirname(file), from));
      found.add(files.includes(`${target}.ts`) ? `${target}.ts` : `${target}/index.ts`);
    }
  }
  return [...found];
}

describe("the RLS bypass, one call further", () => {
  it("is handed only to files that say what bounds them instead", () => {
    const builders = files.filter((f) => mentions(f, "serviceClient("));
    const unlisted = builders
      .flatMap((f) => handsTheClientTo(f).map((to) => [f, to] as const))
      .filter(([, to]) => !SERVICE_CLIENT_ALLOWLIST.has(to) && !RECEIVES_THE_SERVICE_CLIENT.has(to))
      .map(([from, to]) => `${from} -> ${to}`);

    expect(
      unlisted,
      "these receive the service client, which no policy filters, from a file that " +
        "builds it. Add the receiver to RECEIVES_THE_SERVICE_CLIENT with what bounds its " +
        "queries, or hand it the caller's own client instead.",
    ).toEqual([]);
  });

  it("finds the hand-overs it is meant to find", () => {
    // Without this, a scan that matched nothing would pass on nothing.
    expect(handsTheClientTo("routes/slack.ts")).toContain("lib/slack/handle.ts");
    expect(handsTheClientTo("routes/account.ts")).toContain("lib/connections/release.ts");
  });

  it.each([...RECEIVES_THE_SERVICE_CLIENT.keys()])("still exists: %s", (file) => {
    expect(files).toContain(file);
  });
});
