import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import {
  handBackBrowser,
  liveBrowser,
  stopConversationBrowser,
  takeOverBrowser,
} from "../lib/browser/controls";
import {
  CREDENTIAL_MAX_BYTES,
  credentialsFor,
  forgetCredential,
  saveCredential,
  siteHostOf,
  type CredentialBinding,
  type CredentialScope,
  type SaveRefusal,
} from "../lib/browser/credentials";
import { openBrowsersAmong } from "../lib/browser/live";
import { browserLiveUrl } from "../lib/browser/profiles";
import { runInFlight } from "../lib/browser/sessions";
import { HUMAN_GIVE_UP_HOURS } from "../lib/browser/sweep";
import {
  closeTakeover,
  forgetProfile,
  heldTakeover,
  openTakeover,
  providerSessionFor,
  takeoverStillLive,
  type RetryableTask,
} from "../lib/browser/takeover";

/**
 * The three caller-bound ends of a browser takeover.
 *
 * A browser task that stopped at a login wall is recoverable: the person opens
 * a browser Covan is renting, signs in with their own hands in their own
 * browser tab, and the task runs again. **No credential is ever typed into
 * Covan, stored by Covan, or sent to Covan.** The password is typed at the
 * site, in a tab Covan does not read.
 *
 * What lives here and nowhere else is the permission question. `lib/browser/
 * takeover.ts` holds the service-role client and answers to no policy, so
 * every check that decides whether this caller may do this is made here,
 * through `c.get("db")` — the caller's own client, with RLS deciding. The
 * module then gets ids it has already been found entitled to.
 *
 * Paths are written in full because every router is mounted at `"/"`.
 */

const browser = new Hono<AppEnv>();

/**
 * No route here is available to an API key, and the gate is on the router
 * rather than on each handler.
 *
 * The rule is `lib/api-key-rule.ts`'s: *a key may not create access that
 * survives its own revocation.* Every route below creates exactly that. `POST`
 * mints a live browser URL carrying the owner's own signed-in cookies, which
 * browser-use documents as full control of that browser. `GET .../current`
 * hands the same URL back. And `close` stops somebody's browser and spends a
 * re-run on their behalf.
 *
 * **`GET .../current` was written without the check, and nothing noticed.**
 * `api-key-refusal.static.test.ts` asked only whether the FILE mentions
 * `refuseIfKeyAuthenticated(` somewhere, so `POST`'s gate answered for a route
 * that returns the same credential and has none. That blind spot is now closed
 * in the ratchet itself, which counts refusals against handlers.
 *
 * Router middleware would be the stronger shape — impossible for the next
 * handler to forget — and it is deliberately NOT used, for a reason worth
 * recording: a sub-app mounted at `"/"` merges its middleware into the parent,
 * so a path pattern broad enough to cover these three would refuse API keys on
 * every unrelated route in the API. So: one explicit call per handler, and
 * anyone adding a handler here has to remember. The ratchet helps only where
 * it is told to look: `HANDLERS_BEYOND_THE_KEY` pins the four
 * `/browser/sessions/:id` handlers one by one; the older ones are still
 * checked per file.
 */
/**
 * How long a takeover's live URL is good for, for the client's countdown.
 *
 * Not re-derived here: `TAKEOVER_EXPIRY_MINUTES` lives beside the code that
 * writes the row, and the route answers with the row's own `expiresAt` so the
 * two cannot drift.
 */

/**
 * The egress to pin a new cookie jar to.
 *
 * Cloudflare puts the request's country on `cf`, and `CF-IPCountry` carries it
 * too. It is the right value rather than a convenient one: spec §1 pins the
 * egress once and reuses it forever, because cookies are bound to the egress
 * they were set from — so the egress should be where the person actually is,
 * which makes the sign-in's risk signals look ordinary to the site and makes
 * every later task arrive from the same place.
 *
 * `T1` and `XX` are Cloudflare's own answers for Tor and for "could not tell",
 * and neither is a country to pin anything to. Null then, which leaves the
 * provider to choose — no worse than the unpinned behaviour this replaces.
 *
 * **Lowercased, and `gb` rewritten.** browser-use's `proxyCountryCode` is a
 * 240-value lowercase enum, and it is not quite ISO 3166-1: the United
 * Kingdom is spelled `uk` there, where `CF-IPCountry` says `GB`. Sent
 * unmapped it is a 422 on every takeover from the UK — a whole country
 * unable to sign in to anything, with "could not open a browser for you" as
 * the only symptom. The provider's four other absences (`cn`, `ax`, `io`,
 * `um`) are not aliases but countries it has no proxy in at all, so there is
 * nothing to rewrite them to; `openTakeover` drops the pin and opens unpinned
 * when the provider refuses one, which also covers whatever that list says
 * next year.
 */
const PROVIDER_SPELLING: Record<string, string> = { gb: "uk" };

function egressCountry(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const raw = c.req.header("CF-IPCountry");
  if (!raw || raw === "XX" || raw === "T1") return null;
  const code = raw.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  return PROVIDER_SPELLING[code] ?? code;
}

/**
 * POST /browser/takeovers — mint a live browser for its owner.
 *
 * The `liveUrl` comes back **in this response body and nowhere else.**
 * browser-use is explicit: *"Treat the URL as a credential: anyone with it can
 * interact with the active browser."* So it is never written to a row, never
 * logged, and never put in a message — see §4a, which is about the two paths
 * that are not the grants.
 */
browser.post("/browser/takeovers", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "take over a browser");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const body = await c.req
    .json<{ browserTaskId?: unknown }>()
    .catch((): { browserTaskId?: unknown } => ({}));
  const browserTaskId = typeof body.browserTaskId === "string" ? body.browserTaskId : null;

  /**
   * The task is read through the caller's own client, which is the whole
   * permission check: 0073's policy on `browser_tasks` is
   * `user_id = auth.uid() and is_workspace_member(workspace_id)`, so a row
   * that is not this person's, or is in a workspace they have left, simply is
   * not there. A 404 is therefore the honest answer to "not yours" as well as
   * to "no such thing", and it is the same answer either way on purpose.
   *
   * `workspace_id` comes from the row rather than from the request, so a
   * caller cannot name a room to act in.
   */
  let workspaceId: string;
  if (browserTaskId) {
    const { data, error } = await db
      .from("browser_tasks")
      .select("id, workspace_id, status, output, retry_of")
      .eq("id", browserTaskId)
      .maybeSingle();
    if (error) {
      console.error("could not read a browser task for takeover", { code: error.code });
      return c.json({ error: "failed to load that browser task" }, 500);
    }
    if (!data) return c.json({ error: "no such browser task" }, 404);

    // The offerable predicate, enforced rather than only rendered. The GET
    // below decides what the card shows; this decides what may happen.
    if (!offerable(data)) {
      return c.json({ error: "that browser task cannot be taken over" }, 409);
    }

    /**
     * Has this task already had its one retry?
     *
     * Spec §3's fourth condition, and it cannot be answered from the row
     * itself — the successor is a *different* row, naming this one in
     * `retry_of`. So it is a query, and it runs **before** `openTakeover`
     * spends anything: 0077's unique index on `browser_takeovers
     * .browser_task_id` would refuse the insert anyway, but by then a real
     * browser has been rented and the provider bills a minute minimum. The
     * index is the guarantee; this is the part that does not cost money.
     *
     * Through the caller's own client, so a successor they cannot see does not
     * count against them.
     */
    const { data: successor, error: successorError } = await db
      .from("browser_tasks")
      .select("id")
      .eq("retry_of", browserTaskId)
      .limit(1)
      .maybeSingle();
    if (successorError) {
      console.error("could not look for a browser task's successor", {
        code: successorError.code,
      });
      return c.json({ error: "failed to load that browser task" }, 500);
    }
    if (successor) {
      return c.json({ error: "that browser task has already been tried again" }, 409);
    }

    workspaceId = String(data.workspace_id);
  } else {
    // No task named: the person's own browser, opened from the chat header to
    // sign in ahead of time (Task 3.1). `openTakeover` gives it the jar to
    // itself first — refused while a conversation's browser is in use, idle
    // ones stopped (ruling R44). It still needs a room, and the only honest
    // one is a workspace the caller is actually in — read through their own
    // client for that reason.
    const { data, error } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (error || !data) return c.json({ error: "you are not in a workspace" }, 409);
    workspaceId = String(data.workspace_id);
  }

  const opened = await openTakeover(c.env, {
    userId: user.id,
    workspaceId,
    browserTaskId,
    /**
     * A constant, and never the person's email.
     *
     * `openTakeover`'s own docblock calls this "a label, not an identity:
     * whatever is passed leaves this deployment", and spec §4 recorded the
     * pseudonymous user id as the WHOLE concession to the subprocessor — so
     * that it would be a decision rather than an accident. Sending an email
     * address here would have been the accident, and nothing in
     * `docs/security.md` or `docs/integrations.md` discloses one leaving.
     * `userId` already buys the reconciliation §4 argued for.
     */
    label: "covan",
    proxyCountryCode: egressCountry(c),
  });

  if (opened.kind === "error") {
    return c.json({ error: opened.message }, opened.status as 400);
  }

  return c.json({ id: opened.id, liveUrl: opened.liveUrl, expiresAt: opened.expiresAt });
});

/**
 * GET /browser/takeovers/current — the reload that must not lock somebody out.
 *
 * `liveUrl` exists only in the body that minted it, and the partial unique
 * index allows one open takeover — so without this, a reloaded chat tab would
 * leave a person locked out of their own signed-in browser for the rest of the
 * window, and the waiting is what destroys the login. Chat tabs get reloaded
 * constantly, which makes this the likeliest day-one failure rather than a
 * theoretical one (§4b).
 *
 * The URL is re-read from the provider rather than remembered, which is also
 * why there is nothing to leak if this row is ever read by something else.
 */
browser.get("/browser/takeovers/current", async (c) => {
  // This route hands back the live URL, so it is the same creation of access
  // POST is, arriving by a read. It was missing this.
  const refusal = refuseIfKeyAuthenticated(c, "take over a browser");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db
    .from("browser_takeovers")
    .select("id, browser_task_id, expires_at, created_at")
    .eq("user_id", user.id)
    .eq("status", "open")
    .maybeSingle();

  if (error) {
    console.error("could not look for a current takeover", { code: error.code });
    return c.json({ error: "failed to load your takeover" }, 500);
  }
  if (!data) return c.json({ takeover: null });

  /**
   * `heldTakeover`'s reading (ruling R51): open is the person's browser until
   * it is closed, even past `expires_at` — the take-over and the hand-back
   * refuse on it, so a reload has to give its Done back rather than an Open
   * browser beside a refusal to press Done somewhere unseen. Done still saves
   * it, and the sweep closes it otherwise. Only once the provider has
   * certainly ended the browser (`takeoverStillLive`) is it "none", without
   * asking; inside that, the provider check below still answers null for a
   * browser that has gone early.
   */
  if (!takeoverStillLive(data.created_at, new Date())) {
    return c.json({ takeover: null });
  }

  /**
   * The provider session id is read with the service-role client inside
   * `takeover.ts`, not here — this route has only the row's own id. So the
   * re-read goes through a lookup that is keyed to the caller, and the id
   * never reaches this file.
   */
  const live = await currentLiveUrl(c.env, String(data.id), user.id);
  if (!live) return c.json({ takeover: null });

  return c.json({
    takeover: {
      id: String(data.id),
      browserTaskId: data.browser_task_id ? String(data.browser_task_id) : null,
      expiresAt: String(data.expires_at),
      liveUrl: live,
    },
  });
});

/**
 * POST /browser/takeovers/:id/close — done signing in.
 *
 * Closing is what stops the provider session, and stopping is the only thing
 * that saves the cookie jar: *"Profile state (cookies, localStorage) is only
 * saved when the session ends."* So this is not a tidy-up — it is the step
 * that makes the sign-in persist, which is why it also re-runs the task.
 *
 * **It can take a few seconds.** `closeTakeover` waits for the provider to
 * report `stopped` before re-running, because re-running against a session
 * that is still shutting down would read a jar that was never written. The
 * wait is bounded inside the module and the route lets it finish rather than
 * answering early: the person has just pressed a button and is waiting for an
 * answer, and a 202 here would mean telling them it worked before knowing.
 */
browser.post("/browser/takeovers/:id/close", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "take over a browser");
  if (refusal) return c.json(refusal, 403);

  const user = c.get("user");
  const closed = await closeTakeover(c.env, {
    takeoverId: c.req.param("id"),
    userId: user.id,
    callerDb: c.get("db"),
  });

  if (closed.kind === "error") {
    return c.json({ error: closed.message }, closed.status as 400);
  }

  return c.json({
    retriedTaskId: closed.retriedTaskId,
    cookieDomains: closed.cookieDomains,
    message: closed.message,
  });
});

/**
 * GET /browser/profile — which sites this person's jar is signed into.
 *
 * Read with the caller's own client, and that is the point rather than a
 * detail: `cookie_domains` is one of the five columns 0077 grants
 * `authenticated` a select on, precisely so a screen can show a person what is
 * being held for them without anything reaching past RLS to fetch it. The
 * columns that would make this a leak — `provider_profile_id`,
 * `proxy_country_code` — are granted to no client role, so this query could
 * not name them if it tried.
 *
 * Refused to an API key for the same reason the rest of this file is, read
 * from the other end: the answer is a list of the sites somebody is signed
 * into, which is reconnaissance rather than work, and no key-driven caller has
 * a use for it.
 */
browser.get("/browser/profile", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "see which sites a browser is signed into");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db
    .from("browser_profiles")
    .select("cookie_domains, created_at, last_used_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("could not read a browser profile", { code: error.code });
    return c.json({ error: "failed to load your browser sign-ins" }, 500);
  }
  if (!data) return c.json({ profile: null });

  return c.json({
    profile: {
      cookieDomains: Array.isArray(data.cookie_domains)
        ? data.cookie_domains.filter((d: unknown): d is string => typeof d === "string")
        : [],
      createdAt: data.created_at ? String(data.created_at) : null,
      lastUsedAt: data.last_used_at ? String(data.last_used_at) : null,
    },
  });
});

/**
 * DELETE /browser/profile — forget every sign-in, without closing the account.
 *
 * §7a's control. Deleting on account closure already worked, and it is not the
 * same right: a person who wants Covan to stop holding a login should not have
 * to leave to get it. A feature whose whole purpose is to accumulate sign-ins
 * needs a door out of it that costs less than the exit.
 *
 * Nothing about the ORDER of the deletions is decided here — `forgetProfile`
 * owns that, because the provider id is the thing being ordered around and
 * this file may not read it. What is decided here is only who may ask.
 */
browser.delete("/browser/profile", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "forget a browser's sign-ins");
  if (refusal) return c.json(refusal, 403);

  const user = c.get("user");
  const result = await forgetProfile(c.env, user.id);
  if (result.kind === "error") return c.json({ error: result.message }, result.status as 409);

  return c.json({ forgotten: result.forgotten });
});

/**
 * Whether a failed task is worth offering a takeover for.
 *
 * Four conditions, and the last is the one that matters for money:
 *
 * - `failed`, because a task that finished has an answer already.
 * - it said *something*, because a task that failed with no output never
 *   reached a page — a 404 or a `MAX_POLLS` give-up — and there is nothing for
 *   a human to sign into.
 * - `retry_of is null`, so a retry is never itself offerable. **This is the
 *   bound on operator spend.** Without it a task that fails at a second wall
 *   is offerable again, and the loop is three HTTP calls per free browser
 *   task that `affordable()` never sees. 0077 makes the same thing a database
 *   fact with a unique index; this is the good error message in front of it.
 * The spec's fourth condition — **no successor yet** — is deliberately NOT
 * here, because it cannot be: the successor is a different row naming this one
 * in `retry_of`, so answering it needs a query rather than a predicate over
 * these three fields. `POST /browser/takeovers` makes that query before it
 * spends anything, and `GET /sessions/:id/browser-tasks`'s caller has every
 * row it needs to answer it client-side. Both do.
 */
function offerable(row: { status?: unknown; output?: unknown; retry_of?: unknown }): boolean {
  return (
    row.status === "failed" &&
    typeof row.output === "string" &&
    row.output.length > 0 &&
    row.retry_of == null
  );
}

/**
 * The browser beside a conversation, from the person's side: watch it, take it
 * over, hand it back, stop it.
 *
 * The same split as the takeover routes above. What is decided HERE is only
 * who may ask: each handler refuses an API key first (a live URL, a browser in
 * somebody's hands and a free retry are all access that would outlive the
 * key — `api-key-refusal.static.test.ts` pins each of these four handlers by
 * name), then reads the `browser_sessions` row through the caller's own
 * client. 0078's policy is the owner's alone, so a colleague in the same
 * shared conversation — who sees the answers, which are ordinary messages —
 * finds no row here, and "not yours" is the same 404 as "no such thing".
 *
 * Everything that needs a provider id is `lib/browser/controls.ts`'s, with the
 * service role, keyed to the row id read here AND the caller's own user id.
 */

type BrowserSessionRow = {
  id: string;
  live_state: unknown;
  human_since: unknown;
  last_run_at: unknown;
};

/**
 * How long after its last run an `agent` row with nothing in flight is taken
 * as let go (ruling R51). `live_state = 'agent'` outlives a finished run until
 * the open tab's poll or the cron settles it; ten minutes is the idle sweep's
 * own reading of "nobody is using this browser" (0078), and well past the
 * time a finished run takes to be settled by either.
 */
const AGENT_LET_GO_MINUTES = 10;

/**
 * Whether a Stop of this row would be accepted, given whether a run of it is
 * in flight: never under a run (R50), and an `agent` row only once its last
 * run is `AGENT_LET_GO_MINUTES` old. A row with no readable last run has no
 * run to wait on. The stop route and the Settings list both ask this, so
 * Settings offers Stop exactly when it works.
 */
function stopAccepted(
  row: { live_state: unknown; last_run_at: unknown },
  running: boolean,
  now: number,
): boolean {
  if (running) return false;
  if (row.live_state !== "agent") return true;
  const at = Date.parse(String(row.last_run_at));
  return !Number.isFinite(at) || now - at >= AGENT_LET_GO_MINUTES * 60_000;
}

/** The caller's own browser, or the response that says why not. */
async function ownBrowser(
  c: Context<AppEnv>,
): Promise<{ row: BrowserSessionRow } | { refused: Response }> {
  const { data, error } = await c
    .get("db")
    .from("browser_sessions")
    .select("id, live_state, human_since, last_run_at")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) {
    console.error("could not read a conversation's browser", { code: error.code });
    return { refused: c.json({ error: "failed to load that browser" }, 500) };
  }
  if (!data) return { refused: c.json({ error: "no such browser" }, 404) };
  return { row: data as BrowserSessionRow };
}

function owned(c: Context<AppEnv>, row: BrowserSessionRow) {
  return { browserSessionId: String(row.id), userId: c.get("user").id };
}

/**
 * GET /browser/sessions/:id/live — the live view, for its owner, minted fresh.
 *
 * `liveUrl` is in this body and nowhere else: *"Treat the URL as a
 * credential"* — so it is not logged here, not stored by the module, and the
 * response says `no-store` so no cache keeps it either. Idempotent, so a
 * reloaded tab asks again and gets its browser back (Review focus 3).
 */
browser.get("/browser/sessions/:id/live", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "watch a browser");
  if (refusal) return c.json(refusal, 403);

  const own = await ownBrowser(c);
  if ("refused" in own) return own.refused;

  const live = await liveBrowser(c.env, owned(c, own.row));
  if (live.kind === "error") return c.json({ error: live.message }, live.status as 409);

  c.header("Cache-Control", "no-store");
  return c.json({ liveUrl: live.liveUrl, liveState: live.liveState });
});

/**
 * POST /browser/sessions/:id/take-over — the person's hands on the browser.
 *
 * Answers `human` only once the provider has reported the agent's run ended,
 * which can take seconds (Review focus 2); past ten of them it answers 202
 * `cancelling`, the panel stays inert, and the client asks again — the module
 * documents why asking again is the whole of the follow-up. A browser already
 * in the caller's hands is answered from the row, with its own clock, and
 * nothing is asked of the provider.
 */
browser.post("/browser/sessions/:id/take-over", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "take over a browser");
  if (refusal) return c.json(refusal, 403);

  const own = await ownBrowser(c);
  if ("refused" in own) return own.refused;

  if (own.row.live_state === "human") {
    const since = Date.parse(String(own.row.human_since));
    if (Number.isFinite(since)) return c.json({ liveState: "human", humanSince: since });
  }

  /**
   * Ruling R46, R44's reason: not while the caller has a browser of their own
   * open (Task 3.1). It runs on the jar this one does, and whichever of two
   * live browsers stops last writes it — so taking this one too could lose
   * the sign-in being made there, or what is done here. Before
   * `takeOverBrowser`, which is what cancels a run and asks the provider about
   * the browser, so a refusal costs nothing. A browser already in the
   * caller's hands is answered above from the row, as it always was.
   */
  const theirOwnOpen = await heldTakeover(c.env, c.get("user").id);
  if (theirOwnOpen === null) {
    return c.json({ error: "Couldn't check your other browser. Try again in a moment." }, 500);
  }
  if (theirOwnOpen) {
    // Whole sentences, as the hand-back's below: the panel shows them as they come.
    return c.json(
      {
        error:
          "Press Done in the browser you opened first, so your sign-in is saved before you take " +
          "over this one.",
      },
      409,
    );
  }

  const taken = await takeOverBrowser(c.env, owned(c, own.row));
  if (taken.kind === "error") return c.json({ error: taken.message }, taken.status as 502);
  if (taken.kind === "cancelling") return c.json({ liveState: "cancelling" }, 202);
  return c.json({ liveState: "human", humanSince: taken.humanSince });
});

/**
 * POST /browser/sessions/:id/hand-back — Done: the agent continues.
 *
 * The task it continues is the newest one this browser ran, read through the
 * caller's own client — `closeTakeover`'s reason: the follow-up is written
 * into a conversation, and somebody who can no longer read the original
 * should not be able to have it run again. Then the same successor query
 * `POST /browser/takeovers` makes, for the same reason and before anything is
 * spent: one free retry per original, ever.
 *
 * **An optional `{ site }` (R24)** — the sign-in card's Save, which has just
 * stored a login and wants this retry to sign in with it. The client names the
 * site and nothing else: the binding is resolved here, for the caller, by
 * `credentialsFor`, after every rule above has passed and before anything is
 * spent, so a site with no login the caller may use is a 409 that leaves the
 * free retry where it was. Plaintext never arrives from the client on this
 * call. No body, or a body without a site, is the hand-back it always was.
 *
 * **And the saved row's id, `credentialId` (R35)**, which the save answered.
 * Without it the run would bind whichever login `pick` prefers — the caller's
 * own personal one, which may be the very login that just failed, while the
 * person has just saved a new shared one. It is a preference `credentialsFor`
 * honours only for a row the caller may use on this agent and site.
 */
browser.post("/browser/sessions/:id/hand-back", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "hand a browser back");
  if (refusal) return c.json(refusal, 403);

  type HandBackBody = { site?: unknown; credentialId?: unknown };
  const body = await c.req.json<HandBackBody>().catch((): HandBackBody => ({}));
  let site: string | null = null;
  let prefer: string | null = null;
  if (body && body.site !== undefined && body.site !== null) {
    site = typeof body.site === "string" ? siteHostOf(body.site) : null;
    if (!site) {
      return c.json({ error: "That is not a website a saved login can be used on." }, 400);
    }
    if (body.credentialId !== undefined && body.credentialId !== null) {
      if (typeof body.credentialId !== "string" || !UUID.test(body.credentialId)) {
        return c.json({ error: "That is not a saved login." }, 400);
      }
      prefer = body.credentialId;
    }
  }

  const own = await ownBrowser(c);
  if ("refused" in own) return own.refused;
  if (own.row.live_state !== "human") {
    return c.json(
      { error: "this browser is not in your hands, so there is nothing to hand back" },
      409,
    );
  }

  /**
   * Ruling R44: not while the caller has a browser of their own open — the
   * one opened from the chat header to sign in ahead of time (Task 3.1). It
   * runs on the jar this run would carry, and whichever of two live browsers
   * stops last writes it, so the agent's run could overwrite the sign-in being
   * made there. Before the task reads and before `handBackBrowser`, which is
   * the only thing here that calls the provider or writes a row, so the free
   * retry stays where it was. Asked of `takeover.ts`, which reads the
   * caller's own takeovers by their id (`heldTakeover`).
   */
  const theirOwnOpen = await heldTakeover(c.env, c.get("user").id);
  if (theirOwnOpen === null) {
    return c.json({ error: "Couldn't check your other browser. Try again in a moment." }, 500);
  }
  if (theirOwnOpen) {
    return c.json(
      {
        error:
          "Press Done in the browser you opened first, so your sign-in is saved before the " +
          "agent uses it.",
      },
      409,
    );
  }

  const db = c.get("db");
  const { data: original, error } = await db
    .from("browser_tasks")
    .select("id, workspace_id, agent_id, user_id, session_id, task, retry_of, status, stop_reason")
    .eq("browser_session_id", String(own.row.id))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("could not read the task a hand-back continues", { code: error.code });
    return c.json({ error: "failed to load that browser's task" }, 500);
  }
  if (!original) {
    return c.json({ error: "this browser has no task for the agent to continue" }, 409);
  }
  /**
   * Only a task that stopped short is continued — `offerable()`'s rule, which
   * the free retry has always been bound by. `failed` is the login wall (a
   * settled `login_required`) and every other run that did not finish;
   * `stopped` `handed_to_person` is a run the person took over mid-way. A
   * `finished` task already answered, and re-running it would put a second
   * answer in the conversation and spend the retry for nothing; a run stopped
   * at `cost_cap` would get a second full ceiling of the operator's money.
   */
  const continuable =
    original.status === "failed" ||
    (original.status === "stopped" && original.stop_reason === "handed_to_person");
  if (!continuable) {
    return c.json(
      { error: "the last task in this browser has nothing for the agent to continue" },
      409,
    );
  }

  const { data: successor, error: successorError } = await db
    .from("browser_tasks")
    .select("id")
    .eq("retry_of", String(original.id))
    .limit(1)
    .maybeSingle();
  if (successorError) {
    console.error("could not look for a browser task's successor", { code: successorError.code });
    return c.json({ error: "failed to load that browser's task" }, 500);
  }
  if (successor) {
    return c.json({ error: "that browser task has already been tried again" }, 409);
  }

  // The login is the caller's to use on the original's agent, chosen by the
  // same rule `browse` chooses by (own row first, then a shared one whose
  // saver is still a member — R29, R30). The task row was read through the
  // caller's own client, so its agent is one this caller ran.
  let login: CredentialBinding | null = null;
  if (site) {
    try {
      login = await credentialsFor(c.env, {
        agentId: String(original.agent_id),
        userId: c.get("user").id,
        host: site,
        ...(prefer ? { prefer } : {}),
      });
    } catch (err) {
      console.error("could not read a saved login for a hand-back", String(err));
      return c.json({ error: "Couldn't read the saved login. Try again in a moment." }, 500);
    }
    if (!login) {
      return c.json(
        {
          error: `There is no saved login for ${site} you can use here. Save it again, or take over and sign in yourself.`,
        },
        409,
      );
    }
  }

  const handed = await handBackBrowser(c.env, {
    ...owned(c, own.row),
    original: original as RetryableTask,
    ...(login ? { login } : {}),
  });
  if (handed.kind === "error") return c.json({ error: handed.message }, handed.status as 409);
  return c.json({ browserTaskId: handed.browserTaskId });
});

/**
 * POST /browser/sessions/:id/stop — close the panel, and keep what was done in
 * it. Stopping is what saves the jar (*"always stop the session to persist
 * profile state"*); the module says why a failed stop leaves the row for the
 * sweep. Idempotent: a browser already stopped answers 204 again.
 *
 * **Never under a running agent run** (ruling R50). A stop does not cancel a
 * run, and a run whose browser vanished under it settles as a failure (R17)
 * — so it is refused, 409, while a v4 run of it is still `queued` or
 * `running` (one more read, `runInFlight`, through the caller's own client),
 * and while the row says the agent has the browser and its last run is less
 * than `AGENT_LET_GO_MINUTES` old (`stopAccepted`). Past that, an `agent` row
 * with nothing in flight is a finished run nobody has settled — a cron that
 * is not running leaves it there for good — and refusing it for ever was a
 * browser with no way out from Settings, and none at all once its
 * conversation was out of sight (ruling R51). Not knowing is a refusal too,
 * 500: a stop guessed safe is the run killed. The panel's close only hides
 * while the agent holds the browser, so it does not meet this; Settings' Stop
 * can, for a run that started after its list was read, and shows the
 * sentence.
 */
browser.post("/browser/sessions/:id/stop", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "stop a browser");
  if (refusal) return c.json(refusal, 403);

  const own = await ownBrowser(c);
  if ("refused" in own) return own.refused;

  const running = await runInFlight(c.get("db"), String(own.row.id));
  if (running === null) {
    return c.json(
      { error: "Couldn't check whether the agent is using this browser. Try again in a moment." },
      500,
    );
  }
  if (!stopAccepted(own.row, running, Date.now())) {
    return c.json(
      {
        error: "The agent is using this browser right now. Take it over in the conversation first.",
      },
      409,
    );
  }

  const stopped = await stopConversationBrowser(c.env, owned(c, own.row));
  if (stopped.kind === "error") return c.json({ error: stopped.message }, stopped.status as 502);
  return c.body(null, 204);
});

/**
 * Where a browser is, as the caller may see it: the conversation's title and
 * agent, each read through the caller's own client. A conversation they can no
 * longer open — a shared chat made private again, a workspace left — is null,
 * and the screen says something neutral rather than a title RLS would not
 * have handed over.
 */
type Place = {
  conversation: { id: string; title: string | null } | null;
  agent: { id: string; name: string } | null;
};

/** The columns 0078 grants `authenticated` that this list needs. Never a provider id. */
const OPEN_BROWSER_COLUMNS = "id, chat_session_id, agent_id, live_state, human_since, last_run_at";

function laterOf(a: unknown, b: unknown): string | null {
  const times = [a, b].filter((t): t is string => typeof t === "string" && t.length > 0);
  if (times.length === 0) return null;
  return times.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x));
}

/**
 * GET /browser/sessions — the caller's browsers that may still be open, for
 * Settings → Browser sign-ins (Task 3.2, ruling R48), each with a way to end it.
 *
 * Two kinds. The browser beside a conversation: one the agent or the person
 * has the controls of, or one nobody has whose browser has not been seen
 * stopped (the idle sweep's state, 0078). And the caller's open takeover —
 * the browser they opened to sign in ahead of time (Task 3.1), or a v2 task's
 * — of which 0077's partial unique index allows one.
 *
 * **Everything that decides what is shown is read through `c.get("db")`.**
 * 0078's policy is the owner's, with the workspace half that makes a removed
 * member stop seeing their own rows; the select names only columns 0078
 * grants. Whether a browser is still open is the one thing it cannot answer —
 * `provider_browser_id` is granted to no client role — so the ids RLS
 * returned are handed to `openBrowsersAmong`, which reads that column with
 * the service role, narrowed to those ids and this caller, and answers a set
 * of Covan's own ids. A boolean per row is all that reaches the response.
 *
 * **No provider call and no live URL.** This is a list on a settings page;
 * minting a live view to draw it would hand out the credential the panel
 * guards (*"Treat the URL as a credential"*) to a screen that only needs to
 * say a browser exists. Stored state only: about seven subrequests at most —
 * the rows, the open-browser read, the runs in flight, the takeover, its
 * task, the titles and the agents — and fewer when there is less to name.
 *
 * **A row whose last run is past the provider's four-hour lifetime is not
 * asked about.** The provider has ended that browser whatever the row says
 * (`sweep.ts` settles such a row without a stop, for that reason), and
 * leaving it out keeps the `in (...)` to the handful of recent ones rather
 * than every conversation that ever browsed.
 *
 * Refused to an API key for `GET /browser/profile`'s reason: which browsers of
 * somebody's are open, where, and in whose hands is reconnaissance rather
 * than work (`HANDLERS_BEYOND_THE_KEY` pins it by handler).
 */
browser.get("/browser/sessions", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "see which browsers are open");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");
  const failed = { error: "failed to load your open browsers" };

  // Newest first (M7): PostgREST answers at most a thousand rows, and the
  // ones it would cut are then the oldest — past the provider's four-hour
  // lifetime, for anybody short of a thousand runs in four hours — never the
  // one used a minute ago.
  const { data: sessionRows, error } = await db
    .from("browser_sessions")
    .select(OPEN_BROWSER_COLUMNS)
    .eq("user_id", user.id)
    .order("last_run_at", { ascending: false });
  if (error) {
    console.error("could not list a person's browsers", { code: error.code });
    return c.json(failed, 500);
  }
  type Row = {
    id: unknown;
    chat_session_id: unknown;
    agent_id: unknown;
    live_state: unknown;
    human_since: unknown;
    last_run_at: unknown;
  };
  const rows = (sessionRows ?? []) as Row[];

  const lifetime = HUMAN_GIVE_UP_HOURS * 3_600_000;
  const held = (row: Row) => row.live_state === "agent" || row.live_state === "human";
  const candidates = rows.filter((row) => {
    if (held(row)) return true;
    const at = Date.parse(String(row.last_run_at));
    return Number.isFinite(at) && Date.now() - at <= lifetime;
  });

  const open =
    (await openBrowsersAmong(c.env, {
      userId: user.id,
      browserSessionIds: candidates.map((row) => String(row.id)),
    })) ?? new Set<string>();
  // Not knowing which are open shows what the rows themselves say: the ones
  // somebody has the controls of. An idle one is the sweep's either way.
  const listed = candidates.filter((row) => held(row) || open.has(String(row.id)));

  let running = new Set<string>();
  if (listed.length > 0) {
    const { data: runs, error: runsError } = await db
      .from("browser_tasks")
      .select("browser_session_id")
      .in(
        "browser_session_id",
        listed.map((row) => String(row.id)),
      )
      .in("status", ["queued", "running"]);
    if (runsError) {
      /**
       * Fails closed: not knowing is "every row the agent has is running".
       * A row drawn as not running offers a Stop, and under a run that is a
       * button that can only fail: the stop route refuses it (R50), because
       * a stop would pull the browser out from under the agent mid-run,
       * which R17 and R48 forbid. The agent's rows then say
       * "the agent is using it" and link to their conversation, where the
       * panel decides with its own poll; the person's and the idle ones are
       * nobody's run and keep their Stop. Not a 500, because the rest of the
       * list is still right and is the reason the person came here.
       */
      console.error("could not read a person's browser runs", { code: runsError.code });
      running = new Set(
        listed.filter((row) => row.live_state === "agent").map((row) => String(row.id)),
      );
    } else {
      running = new Set(
        ((runs ?? []) as Array<{ browser_session_id: unknown }>).map((r) =>
          String(r.browser_session_id),
        ),
      );
    }
  }

  const { data: takeoverRow, error: takeoverError } = await db
    .from("browser_takeovers")
    .select("id, browser_task_id, expires_at, created_at")
    .eq("user_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (takeoverError) {
    console.error("could not look for a person's open takeover", { code: takeoverError.code });
    return c.json(failed, 500);
  }

  // A task's takeover is where its task was asked; the caller's own browser
  // (Task 3.1) belongs to no conversation.
  let takeoverChat: string | null = null;
  let takeoverAgent: string | null = null;
  if (takeoverRow?.browser_task_id) {
    const { data: task } = await db
      .from("browser_tasks")
      .select("id, session_id, agent_id")
      .eq("id", String(takeoverRow.browser_task_id))
      .maybeSingle();
    if (task) {
      takeoverChat = task.session_id ? String(task.session_id) : null;
      takeoverAgent = task.agent_id ? String(task.agent_id) : null;
    }
  }

  const chatIds = [
    ...new Set([
      ...listed.map((row) => String(row.chat_session_id)),
      ...(takeoverChat ? [takeoverChat] : []),
    ]),
  ];
  const agentIds = [
    ...new Set([
      ...listed.map((row) => String(row.agent_id)),
      ...(takeoverAgent ? [takeoverAgent] : []),
    ]),
  ];

  const titles = new Map<string, string | null>();
  if (chatIds.length > 0) {
    const { data: chats, error: chatsError } = await db
      .from("chat_sessions")
      .select("id, title")
      .in("id", chatIds);
    if (chatsError) console.error("could not name a person's browsers", { code: chatsError.code });
    for (const chat of (chats ?? []) as Array<{ id: unknown; title: unknown }>) {
      titles.set(String(chat.id), typeof chat.title === "string" && chat.title ? chat.title : null);
    }
  }
  const names = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data: agents, error: agentsError } = await db
      .from("agents")
      .select("id, name")
      .in("id", agentIds);
    if (agentsError) {
      console.error("could not name a person's browsers' agents", { code: agentsError.code });
    }
    for (const agent of (agents ?? []) as Array<{ id: unknown; name: unknown }>) {
      names.set(String(agent.id), String(agent.name ?? ""));
    }
  }

  const place = (chatId: string | null, agentId: string | null): Place => ({
    conversation:
      chatId && titles.has(chatId) ? { id: chatId, title: titles.get(chatId) ?? null } : null,
    agent: agentId && names.has(agentId) ? { id: agentId, name: names.get(agentId)! } : null,
  });

  const browsers = listed
    .map((row) => ({
      id: String(row.id),
      ...place(String(row.chat_session_id), String(row.agent_id)),
      liveState: row.live_state === "agent" || row.live_state === "human" ? row.live_state : "none",
      running: running.has(String(row.id)),
      // The stop route's own rule, so Settings offers Stop exactly when it
      // would be accepted (ruling R51). A runs read that failed counts every
      // agent row as running, so it is not stoppable either: fails closed.
      stoppable: stopAccepted(row, running.has(String(row.id)), Date.now()),
      browserOpen: open.has(String(row.id)),
      lastUsedAt: laterOf(row.last_run_at, row.human_since),
    }))
    // Most recently used first; a row with no time at all goes last.
    .sort((a, b) => (Date.parse(b.lastUsedAt ?? "") || 0) - (Date.parse(a.lastUsedAt ?? "") || 0));

  return c.json({
    browsers,
    takeover: takeoverRow
      ? {
          id: String(takeoverRow.id),
          forTask: Boolean(takeoverRow.browser_task_id),
          ...place(takeoverChat, takeoverAgent),
          openedAt: String(takeoverRow.created_at),
          expiresAt: String(takeoverRow.expires_at),
        }
      : null,
  });
});

/**
 * The login you save: a site's username and password kept for one agent, so
 * its browser signs in without asking every time (0079, Task 2.4).
 *
 * The same split as everything above. Who may ask is decided HERE, through the
 * caller's own client — the agent row for a save, the login row for a forget,
 * the list itself for a read — so RLS answers "not yours" before anything
 * else is asked. `lib/browser/credentials.ts` holds the service role, the
 * encryption and the only plaintext, and re-checks what a caller's word must
 * not settle.
 *
 * **No value leaves the request.** The save's body is the one place a
 * password crosses this API, and it goes from the parsed body straight into
 * `saveCredential`: no log line here names the body or any field of it, the
 * refusals are fixed sentences of this file's rather than anything that could
 * quote what was typed, a failed save is reduced to a status, and the answer
 * is the saved row's public fields. Nothing in this worker logs request
 * bodies (`index.ts` mounts cors, the rate limiter and auth, none of which
 * read one); `browser.test.ts` spies every console level through a save and a
 * failed one to keep it so.
 *
 * Refused to an API key, each handler by itself (`HANDLERS_BEYOND_THE_KEY`):
 * a login planted by a key keeps signing in as somebody after the key is
 * revoked, a forget by one is a team's login gone, and the list is a map of
 * where somebody's passwords are kept.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column 0079 grants `authenticated` that a screen needs. Never a ciphertext. */
const SAVED_LOGIN_COLUMNS =
  "id, workspace_id, agent_id, user_id, scope, site_host, label, created_at, last_used_at";

/**
 * `saveCredential`'s refusals, in this product's words. Fixed sentences, so
 * none of them can carry what was typed — the label check is about the
 * username, and a sentence quoting it would be the leak the check prevents.
 */
function saveRefusal(
  reason: SaveRefusal,
  host: string,
): { status: 400 | 404 | 409; error: string } {
  switch (reason) {
    case "invalid_scope":
      return {
        status: 400,
        error: "A login is saved either for you or for everyone using this agent.",
      };
    case "invalid_host":
      return { status: 400, error: "That is not a website address a login can be saved for." };
    case "invalid_label":
      return { status: 400, error: "Give the login a name, like “LinkedIn — sales account”." };
    case "label_is_username":
      return {
        status: 400,
        error: "The name is shown to others, so it cannot contain the username.",
      };
    case "label_is_password":
      return {
        status: 400,
        error: "The name is shown to others, so it cannot contain the password.",
      };
    case "invalid_username":
      return {
        status: 400,
        error: `The username must be between 1 and ${CREDENTIAL_MAX_BYTES} bytes.`,
      };
    case "invalid_password":
      return {
        status: 400,
        error: `The password must be between 1 and ${CREDENTIAL_MAX_BYTES} bytes.`,
      };
    case "agent_not_found":
      return { status: 404, error: "That agent is not in this workspace." };
    case "shared_exists":
      // R28: one shared login per site per agent; a departed saver's row
      // blocks a new one until somebody who may removes it (2.2's review).
      return {
        status: 409,
        error: `A shared login for ${host} already exists. Ask a workspace admin, or whoever saved it, to remove it first.`,
      };
  }
}

/** A body field as text, or empty — never `String(object)`. */
function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/**
 * GET /browser/credentials — the saved logins this caller can see: their own,
 * and the shared ones of agents they may use (0079's read policy, which this
 * read goes through). `?agentId=` narrows it to one agent's, for that agent's
 * settings.
 *
 * Label, host, scope, when it was saved and last used, whether it is the
 * caller's own and whether they may forget it. Never a username — there is no
 * plaintext column to name, and both ciphertexts are granted to nobody — and
 * not the saver's id either: `own` says the one thing a screen needs from it.
 * `canForget` is `forgetCredential`'s rule, read off the caller's own
 * memberships: their own row always, a shared row when they are an admin of
 * its workspace. The DELETE decides again; this only spares a screen a button
 * that can only be refused.
 */
browser.get("/browser/credentials", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "see which sites have a saved login");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");
  const agentId = c.req.query("agentId");
  // Not an agent at all, so no login of one: answered without a query that
  // Postgres would answer 22P02.
  if (agentId !== undefined && !UUID.test(agentId)) return c.json({ logins: [] });

  let query = db.from("browser_credentials").select(SAVED_LOGIN_COLUMNS);
  if (agentId) query = query.eq("agent_id", agentId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    console.error("could not list saved logins", { code: error.code });
    return c.json({ error: "failed to load your saved logins" }, 500);
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  let adminOf = new Set<string>();
  if (rows.some((row) => row.scope === "agent" && row.user_id !== user.id)) {
    const { data: roles, error: rolesError } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("role", "admin");
    if (rolesError) {
      // Not knowing is "not an admin": the button is hidden, not the list.
      console.error("could not read a caller's admin workspaces", { code: rolesError.code });
    } else {
      adminOf = new Set(
        ((roles ?? []) as Array<{ workspace_id: unknown }>).map((r) => String(r.workspace_id)),
      );
    }
  }

  return c.json({
    logins: rows.map((row) => {
      const own = row.user_id === user.id;
      return {
        id: String(row.id),
        agentId: String(row.agent_id),
        label: String(row.label ?? ""),
        siteHost: String(row.site_host ?? ""),
        scope: row.scope === "agent" ? "agent" : "owner",
        lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
        createdAt: String(row.created_at),
        own,
        canForget: own || (row.scope === "agent" && adminOf.has(String(row.workspace_id))),
      };
    }),
  });
});

/**
 * POST /browser/credentials — save (or replace) a login, from the sign-in
 * card's dialog.
 *
 * The agent is read through the caller's own client first, so an agent they
 * may not use — another workspace's, one in the trash — is a 404 and nothing
 * is encrypted or written. Its workspace comes from that row, never from the
 * request. Then `saveCredential`, whose refusals become `saveRefusal`'s
 * sentences: the dialog shows them as they are.
 */
browser.post("/browser/credentials", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "save a login for an agent");
  if (refusal) return c.json(refusal, 403);

  const parsed = await c.req.json<unknown>().catch(() => null);
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const agentId = field(body, "agentId");
  if (!UUID.test(agentId)) return c.json({ error: "Name the agent this login is for." }, 400);

  const db = c.get("db");
  const { data: agent, error } = await db
    .from("agents")
    .select("id, workspace_id")
    .eq("id", agentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("could not read an agent for a saved login", { code: error.code });
    return c.json({ error: "Couldn't save that login. Try again in a moment." }, 500);
  }
  if (!agent) return c.json({ error: "That agent is not one you can use." }, 404);

  /**
   * R34, 0021's line: shared things need a member, yours need only
   * membership. Seeing the agent is enough to save a login for oneself; a
   * login every colleague's runs will sign in with is a shared thing, so a
   * viewer — who may use the agent but change nothing of the team's — is
   * refused. Asked through the caller's own client, of the agent's workspace,
   * and `can_write_in_workspace`'s bias kept: anything but a viewer may.
   */
  const requested = field(body, "scope");
  if (requested === "agent") {
    const { data: membership, error: roleError } = await db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", String(agent.workspace_id))
      .eq("user_id", c.get("user").id)
      .maybeSingle();
    if (roleError) {
      console.error("could not read a caller's role for a shared login", { code: roleError.code });
      return c.json({ error: "Couldn't save that login. Try again in a moment." }, 500);
    }
    const role = membership ? String((membership as { role: unknown }).role ?? "") : "";
    if (!role || role === "viewer") {
      return c.json(
        {
          error:
            "Only workspace members who can edit can save a login for everyone. Save it for yourself instead.",
        },
        403,
      );
    }
  }

  const site = field(body, "site");
  let saved;
  try {
    saved = await saveCredential(c.env, {
      workspaceId: String(agent.workspace_id),
      agentId,
      userId: c.get("user").id,
      scope: requested as CredentialScope,
      siteHost: site,
      label: field(body, "label"),
      username: field(body, "username"),
      password: field(body, "password"),
    });
  } catch (err) {
    // `credentials.ts` builds its errors from a table name and a code, so the
    // message carries no value; nothing else of the request is logged.
    console.error("could not save a login", err instanceof Error ? err.message : "unknown");
    return c.json({ error: "Couldn't save that login. Try again in a moment." }, 500);
  }

  if (!saved.ok) {
    const answer = saveRefusal(saved.reason, siteHostOf(site) ?? "this site");
    return c.json({ error: answer.error }, answer.status);
  }
  const { id, scope, siteHost, label, replaced } = saved.credential;
  return c.json({ credential: { id, scope, siteHost, label, replaced } });
});

/**
 * DELETE /browser/credentials/:id — forget a saved login (R29).
 *
 * The id is checked for shape first, because `forgetCredential` would hand a
 * malformed one to Postgres and get 22P02 back as a 500 (2.2's review). Then
 * the row is read through the caller's own client — a login they cannot see
 * is not there — and `forgetCredential` decides with the service role: the
 * saver always, a workspace admin for a shared login, nobody else.
 */
browser.delete("/browser/credentials/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "forget a saved login");
  if (refusal) return c.json(refusal, 403);

  const gone = { error: "That saved login is not there any more." };
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json(gone, 404);

  const { data, error } = await c
    .get("db")
    .from("browser_credentials")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("could not read a saved login to forget", { code: error.code });
    return c.json({ error: "Couldn't forget that login. Try again in a moment." }, 500);
  }
  if (!data) return c.json(gone, 404);

  let forgotten;
  try {
    forgotten = await forgetCredential(c.env, { credentialId: id, userId: c.get("user").id });
  } catch (err) {
    console.error("could not forget a login", err instanceof Error ? err.message : "unknown");
    return c.json({ error: "Couldn't forget that login. Try again in a moment." }, 500);
  }
  if (forgotten.ok) return c.body(null, 204);
  if (forgotten.reason === "forbidden") {
    return c.json(
      { error: "Only a workspace admin, or whoever saved it, can remove a shared login." },
      403,
    );
  }
  return c.json(gone, 404);
});

export { browser, offerable };

/**
 * Re-read a live URL for a takeover the caller owns.
 *
 * Split out so the provider session id is resolved in exactly one place. It
 * goes through `takeover.ts`'s own reader rather than a query here, because
 * `browser_takeovers.provider_session_id` is granted to no client role — this
 * route's `c.get("db")` could not select it even if it tried.
 */
async function currentLiveUrl(
  env: AppEnv["Bindings"],
  takeoverId: string,
  userId: string,
): Promise<string | null> {
  const sessionId = await providerSessionFor(env, { takeoverId, userId });
  if (!sessionId) return null;

  const live = await browserLiveUrl(env, sessionId);
  if (live.kind === "error" || live.value.status !== "active") return null;
  return live.value.liveUrl;
}
