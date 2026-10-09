import { Hono } from "hono";
import type { AppEnv } from "../types";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { browserLiveUrl } from "../lib/browser/profiles";
import {
  closeTakeover,
  forgetProfile,
  openTakeover,
  providerSessionFor,
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
 * every unrelated route in the API. So: three explicit calls, and the knowledge
 * that the static ratchet cannot tell three from one. **Anyone adding a fourth
 * handler here has to remember.**
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
    // No task named: a takeover opened from settings, to sign in ahead of
    // time. It still needs a room, and the only honest one is a workspace the
    // caller is actually in — read through their own client for that reason.
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
    .select("id, browser_task_id, expires_at")
    .eq("user_id", user.id)
    .eq("status", "open")
    .maybeSingle();

  if (error) {
    console.error("could not look for a current takeover", { code: error.code });
    return c.json({ error: "failed to load your takeover" }, 500);
  }
  if (!data) return c.json({ takeover: null });

  // Past its window is not a live browser. Answered as "none" rather than
  // handed back, because opening a new one is what the person wants and
  // `POST` closes the stale row itself.
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) {
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
    signedInTo: closed.cookieDomains,
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
      signedInTo: Array.isArray(data.cookie_domains)
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
