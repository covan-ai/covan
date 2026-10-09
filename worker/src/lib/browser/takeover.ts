import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { createTask, type BrowserResult } from "./client";
import {
  accountHeadroom,
  browserState,
  createBrowser,
  createProfile,
  deleteProfile,
  getProfile,
  stopBrowser,
  TAKEOVER_PROVIDER_MINUTES,
} from "./profiles";
import { recordBrowserTask } from "./tasks";

/**
 * The database writes behind a takeover, and the order they happen in.
 *
 * **Why the service role, when a caller is right there holding a token.**
 * 0077 gives neither `browser_profiles` nor `browser_takeovers` any write
 * policy or write grant for a client role at all, and the reason is in that
 * migration's own header: the whole content of a profile row is an address at
 * a third party, so a client that could write one could point its own row at
 * somebody else's cookie jar — the same attack as reading
 * `provider_profile_id`, through a different door. The two columns this
 * module exists to handle are withheld from reading as well: with one
 * deployment-wide `BROWSER_USE_API_KEY`, `provider_profile_id` and
 * `provider_session_id` are not labels but the entire address of the thing,
 * and the boundary between two tenants at the provider. So neither the create
 * nor the stop could be issued through a user client even if there were one
 * to issue it with. `lib/browser/tasks.ts` carries the same argument for
 * `browser_tasks`.
 *
 * **It cannot borrow `recordBrowserTask`'s exemption unqualified, and the
 * difference is worth stating.** That writer earns *"nothing here decides
 * anything"* because no caller-supplied value reaches its predicate: every id
 * comes from `ToolContext`. Here one does — `POST /browser/takeovers/:id/close`
 * puts a takeover id in a URL path, and this client bypasses RLS, so an id
 * alone would be the whole authorization of a stop. An unguessable uuid is not
 * an authorization control: it would let one signed-in person stop another's
 * browser mid-login, destroying a sign-in in progress and starting an unbilled
 * re-run.
 *
 * So **every mutation here is scoped to the caller's own user id**, which the
 * route resolved from the authenticated request, and the ids that are not
 * scoped by it are ones read back out of a row that was. The claim on a close
 * matches `id` AND `user_id` AND `status = 'open'`, so somebody else's
 * takeover answers exactly what an already-closed one answers: nothing
 * claimed, nothing stopped. That is defence in depth beneath the route's own
 * check rather than a replacement for it — the route still reads the row
 * through the caller's client first, because that is the only client RLS can
 * resolve a caller for, and `workspace_id` on the takeover row exists
 * precisely so the close's re-read of the original task can fail for somebody
 * who left the workspace mid-sign-in.
 *
 * **`liveUrl` is returned and never stored.** browser-use, verbatim: *"Treat
 * the URL as a credential: anyone with it can interact with the active
 * browser."* So it appears in `openTakeover`'s return value, in no insert, in
 * no update and in no log line — the same thing `POST /composio/connect` does
 * with Composio's hosted URL, and the reason `browserState` and `stopBrowser`
 * in `profiles.ts` parse no URL at all.
 */

/**
 * How long Covan gives somebody to sign in.
 *
 * Strictly less than `TAKEOVER_PROVIDER_MINUTES`, and the gap is the entire
 * reason there are two numbers. A stop is the only thing that saves the cookie
 * jar — *"if a session is left open or times out, changes may not be
 * persisted"* — so the five minutes between this and the provider's own
 * timeout are the window in which the cron sweep can still stop an abandoned
 * browser and save the login somebody just performed. Two whole five-minute
 * ticks of slack; equal values would leave the sweep none.
 *
 * 0077 deliberately does not check this. Its constraint compares `expires_at`
 * to `created_at` and no further, because a check against a window length
 * would put that length in a third place and would start refusing valid rows
 * the day the provider window were lengthened. The invariant is this module's
 * to hold, and `takeover.test.ts` holds it.
 */
export const TAKEOVER_EXPIRY_MINUTES = 10;

/**
 * Slots kept back for `browse` tasks already in flight.
 *
 * The concurrency pool is account-wide across every tenant on one deployment
 * key, and a takeover holds a slot for fifteen minutes — which is fifteen
 * minutes of somebody else's task answering 429, and of this person's own
 * re-run answering it too. Asked before a slot is taken, which is
 * `composio.ts:264-268`'s rule: *"Before the network, deliberately."*
 */
const POOL_RESERVE = 2;

/**
 * How long to keep asking whether the browser has actually stopped.
 *
 * A 200 on the stop request is not a promise that persistence finished, and
 * re-running the task too early produces the one failure a person cannot
 * interpret: they sign in, press done, and are told the page asked them to
 * sign in. Bounded rather than patient — and giving up leaves
 * `provider_stopped_at` null, which is the state the sweep retries.
 *
 * **Worst case this holds the request for five seconds** (`SETTLE_ATTEMPTS` x
 * `SETTLE_DELAY_MS`) and spends five status requests on top of the stop, and
 * it is skipped entirely when the stop's own response already says `stopped`.
 * Whether the route waits that out or answers early is the route's call, not
 * this module's; the bound is stated here so Task 5 does not have to measure
 * it.
 */
const SETTLE_ATTEMPTS = 5;
const SETTLE_DELAY_MS = 1_000;

/** A person's jar, as the rest of the worker needs it: our id, theirs, the pinned egress. */
export type TakeoverProfile = {
  id: string;
  providerProfileId: string;
  proxyCountryCode: string | null;
};

/**
 * The original attempt, in the column names it has in the database.
 *
 * Snake_case because this is the row as the caller's own client read it, and
 * renaming it on the way through would invite a route to build one by hand
 * from somewhere else.
 */
export type RetryableTask = {
  id: string;
  workspace_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  task: string;
  /** Set when this row is itself a successor. One retry per original, ever. */
  retry_of: string | null;
};

/** A sentence for the person and a status for the route to answer with. */
type Refusal = { kind: "error"; status: number; message: string };

export type OpenTakeoverResult =
  { kind: "ok"; id: string; liveUrl: string | null; expiresAt: string } | Refusal;

export type CloseTakeoverResult =
  { kind: "ok"; retriedTaskId: string | null; cookieDomains: string[]; message: string } | Refusal;

/**
 * Injected the way `poller.ts` injects its own, because that is how every
 * dispatcher and writer here is tested: `??` against the real thing, and the
 * resolved values passed down rather than re-resolved.
 */
export type TakeoverDeps = {
  db: SupabaseClient;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

function resolve(env: RoutineEnv, overrides: Partial<TakeoverDeps>): TakeoverDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
  };
}

function minutesFrom(at: Date, minutes: number): string {
  return new Date(at.getTime() + minutes * 60_000).toISOString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * A database error, reduced to the two fields that cannot carry a row.
 *
 * PostgREST hands Postgres' `DETAIL` back as `details`, and a CHECK
 * violation's detail is `Failing row contains (…)` — every column of the row
 * that failed. On `browser_takeovers` that row carries `provider_session_id`,
 * which is credential-equivalent (0077), so logging the error object is §4a's
 * *"a log line becomes a live browser"* arriving by the database's door
 * instead of the provider's. `code` says what rule was broken and `message`
 * says which constraint; neither quotes the row.
 *
 * Used on EVERY database error this file logs, including writes whose payload
 * carries nothing interesting — a NOT NULL violation quotes the failing row
 * too, and "which of these could ever carry an id" is exactly the judgement
 * §4a asks us to stop making one site at a time. `takeover.test.ts` asserts
 * the rule against the source rather than per call.
 */
function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

/**
 * How long a half-made profile row may sit before another request may finish
 * it off.
 *
 * `ensureProfile` claims the unique index before it calls the provider, so a
 * row naming no jar is normally a request that is mid-flight — and a second
 * request that provisioned it anyway would create the duplicate profile at
 * browser-use that the insert-first order exists to prevent. But a request
 * that died between its claim and its fill leaves that row forever, and
 * reading it only ever as "somebody is busy" would lock this person out of the
 * feature permanently, with no amount of retrying clearing it.
 *
 * So the row is given a staleness window, the same way `claimed_at` and
 * `p_stale_after` settle the identical question for a claimed task. A minute,
 * because the provider call it waits on is bounded by `client.ts`'s
 * `TIMEOUT_MS` of fifteen seconds: past a minute the claimant is not slow, it
 * is gone.
 */
const PROVISIONING_STALE_MS = 60_000;

/** What a caller wants a jar to be, which is only ever used when one is created. */
type ProfileWanted = { label: string; proxyCountryCode?: string | null };

/** The row as it is stored, including the one column only `ensureProfile` reads. */
type ProfileRow = {
  id: string;
  providerProfileId: string | null;
  proxyCountryCode: string | null;
  createdAt: string | null;
};

async function readProfileRow(db: SupabaseClient, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await db
    .from("browser_profiles")
    .select("id, provider_profile_id, proxy_country_code, created_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("could not read a browser profile", problem(error));
    return null;
  }
  if (!data) return null;
  return {
    id: String(data.id),
    providerProfileId: text(data.provider_profile_id),
    proxyCountryCode: text(data.proxy_country_code),
    createdAt: text(data.created_at),
  };
}

/**
 * The jar this person already has, or nothing. Never creates one.
 *
 * This is what `browse` calls on every turn that attaches a profile, which is
 * why it answers null rather than an error for every unhappy case: a task that
 * runs against the public web is the behaviour this feature was added beside,
 * not a failure.
 *
 * **A row whose `provider_profile_id` is still empty answers null**, and that
 * is the safe direction rather than a technicality. `ensureProfile` claims the
 * unique index before it calls the provider, so for the width of one HTTP
 * request there is a row naming no jar at all. Attaching that to a task would
 * send the provider an empty `profileId`; treating it as "no profile yet"
 * sends no `sessionSettings`, which is the request this tool made before the
 * feature existed. `ensureProfile` is the one caller that reads that state as
 * the third thing it is — a claim held, provisioning unfinished.
 */
export async function profileFor(
  env: RoutineEnv,
  userId: string,
  overrides: Partial<TakeoverDeps> = {},
): Promise<TakeoverProfile | null> {
  const { db } = resolve(env, overrides);
  const row = await readProfileRow(db, userId);
  if (!row?.providerProfileId) return null;
  return {
    id: row.id,
    providerProfileId: row.providerProfileId,
    proxyCountryCode: row.proxyCountryCode,
  };
}

/**
 * Find or create the jar, in the one order that cannot orphan a profile.
 *
 * **The Covan row is inserted first, and the provider is called only if that
 * insert won.** Two devices, or one double-click before the first response
 * lands, and the obvious order calls `POST /profiles` twice: one insert wins
 * the unique index on `user_id` and the loser has already left a profile at
 * browser-use that nothing in this database can name and that counts against
 * the deployment's profile limit forever. `userId` on the create call is not
 * documented as an idempotency key and must not be used as one. So the insert
 * is `on conflict (user_id) do nothing ... returning` — `claimItemKeys` in
 * `lib/routines/delivery.ts` claims its keys with the same shape for the same
 * reason — and a conflict means re-read rather than create.
 *
 * **0077 has `provider_profile_id not null`, so the claim needs a value, and
 * the empty string is it.** That sentinel is deliberate rather than tidy: a
 * nullable column with `check (… is null or … <> '')` would be the more honest
 * schema, and it would put an `if (!id)` branch into the sweep, the forgetting
 * path and `browse`. The sentinel confines the awkwardness to the one function
 * that creates it.
 *
 * Which makes a row holding `''` **three** states, not two, and the third is
 * the one a first draft misses: no row at all, a row naming a jar, and a row
 * whose claim is held with provisioning unfinished. The last one is either a
 * request still in flight — leave it alone, or two profiles get made — or a
 * request that died, in which case this is the only thing that can ever
 * finish it. `PROVISIONING_STALE_MS` is what tells those apart.
 *
 * **The provider's message never reaches the caller.** `POST /profiles`
 * answers 402 *"Profile limit exceeded"* against the whole deployment key, so
 * on a shared key the Nth person's first takeover is the one that fails; and
 * an error message from here becomes `message_steps.result_excerpt`, which
 * 0060 grants `authenticated` a select on for every column. One sentence,
 * never the body.
 */
export async function ensureProfile(
  env: RoutineEnv,
  userId: string,
  input: {
    /** What the profile is called at the provider. A label, not an identity. */
    label: string;
    /**
     * The egress to pin the jar to, **written on creation and never after**.
     *
     * Spec §1 pins this once and reuses it forever, and the failure it buys
     * off is the design's nastiest: cookies are bound to the egress they were
     * set from, so a jar filled through one datacentre and used through
     * another is silently invalidated by the site — it works once, then every
     * later task hits a login wall, and the sign-in itself is what trips a
     * risk engine into demanding an email code or locking the account. Which
     * is why re-reading an existing row must never overwrite it: a jar whose
     * recorded egress changed is a jar that stops working, and the column is
     * the only record of where it was filled.
     */
    proxyCountryCode?: string | null;
  },
  overrides: Partial<TakeoverDeps> = {},
): Promise<BrowserResult<TakeoverProfile>> {
  const deps = resolve(env, overrides);
  const { db } = deps;

  const held = await readProfileRow(db, userId);
  if (held) return finishRow(env, deps, userId, input, held);

  const { data: claimed, error: claimError } = await db
    .from("browser_profiles")
    .upsert(
      // Not null, and not yet known: the provider has not been called. This
      // placeholder IS the claim on the unique index.
      { user_id: userId, provider_profile_id: "" },
      { onConflict: "user_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (claimError) {
    console.error("could not claim a browser profile row", problem(claimError));
    return { kind: "error", status: 500, message: CANNOT_SET_UP };
  }

  if (claimed) {
    // We hold the index. Nothing else can be provisioning this person.
    return provision(env, deps, userId, input, String(claimed.id));
  }

  // Somebody else won the index between our read and our insert. Re-read, and
  // call the provider zero times unless that row turns out to be abandoned.
  const won = await readProfileRow(db, userId);
  if (!won) {
    // Claimed by somebody and already gone again — a provider failure handing
    // its own claim back. Nothing to join, and no reason to race it.
    return { kind: "error", status: 409, message: TRY_AGAIN };
  }
  return finishRow(env, deps, userId, input, won);
}

/** Ready, somebody else's business, or ours to finish. See `ensureProfile`. */
async function finishRow(
  env: RoutineEnv,
  deps: TakeoverDeps,
  userId: string,
  input: ProfileWanted,
  row: ProfileRow,
): Promise<BrowserResult<TakeoverProfile>> {
  if (row.providerProfileId) {
    // The stored egress, not the one that was asked for. Pinned once. See
    // `ensureProfile`'s `proxyCountryCode`.
    return {
      kind: "ok",
      value: {
        id: row.id,
        providerProfileId: row.providerProfileId,
        proxyCountryCode: row.proxyCountryCode,
      },
    };
  }
  if (!staleClaim(row.createdAt, deps.now())) {
    // A request is between its own claim and its own provider call. Finishing
    // it for them would make the second profile this order exists to prevent.
    return { kind: "error", status: 409, message: TRY_AGAIN };
  }
  // Abandoned. Whatever the dead attempt may have left at the provider cannot
  // be named from here — it never got written down — so this creates a fresh
  // one, which is one orphan rather than one per attempt.
  return provision(env, deps, userId, input, row.id);
}

function staleClaim(createdAt: string | null, now: Date): boolean {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  // `created_at` is `not null default now()`, so this is unreachable. Counted
  // as stale anyway, because the recoverable direction is one extra profile at
  // the provider and the other is a person locked out of the feature forever.
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= PROVISIONING_STALE_MS;
}

/** Make the jar at the provider and write its id onto the row we hold. */
async function provision(
  env: RoutineEnv,
  deps: TakeoverDeps,
  userId: string,
  input: ProfileWanted,
  rowId: string,
): Promise<BrowserResult<TakeoverProfile>> {
  const { db, now } = deps;
  const proxyCountryCode = input.proxyCountryCode ?? null;
  const created = await createProfile(env, { name: input.label, userId });

  if (created.kind === "error") {
    // Status only. The body of this particular failure says "Profile limit
    // exceeded" and is about the deployment rather than the person, and it
    // would otherwise be readable by every member of a shared session.
    console.error("browser-use would not create a profile", created.status);
    await handBackClaim(db, userId, rowId);
    return {
      kind: "error",
      status: created.status,
      message:
        created.status === 402
          ? "this deployment has used up its browser profiles, so a sign-in cannot be set up " +
            "right now. Whoever runs it has to raise the limit."
          : CANNOT_SET_UP,
    };
  }

  const providerProfileId = text(created.value.id);
  if (!providerProfileId) {
    /**
     * A created profile with no id is not something to write down, and above
     * all not something to hand on: `/profiles/` and `/profiles/{id}` are
     * different endpoints, so an empty id would turn a read of one jar into a
     * list of all of them, and `sessionSettings.profileId: ""` into whatever
     * the provider makes of that. The claim goes back and the person is told
     * to try again.
     */
    console.error("browser-use created a profile with no id");
    await handBackClaim(db, userId, rowId);
    return { kind: "error", status: 502, message: CANNOT_SET_UP };
  }

  const { data: filled, error: fillError } = await db
    .from("browser_profiles")
    .update({
      provider_profile_id: providerProfileId,
      // Written here and nowhere else, because here is the only moment the jar
      // is created. See `ensureProfile`'s `proxyCountryCode`.
      proxy_country_code: proxyCountryCode,
      cookie_domains: created.value.cookieDomains,
      last_used_at: now().toISOString(),
    })
    .eq("id", rowId)
    // Keyed to the person as well as to the row, which is this module's rule
    // for every write it makes. See the file header.
    .eq("user_id", userId)
    /**
     * And to the claim this function believes it holds.
     *
     * Two requests can both find the same abandoned `''` row stale and both
     * reach here with a profile of their own. Without this clause the second
     * overwrites the first, and the loser's jar is a profile nothing records —
     * so the person signs in to a browser rented against it and the close
     * reads an empty jar back, which is the one failure they cannot interpret.
     * With it, exactly one filler wins and the other deletes its own orphan
     * below.
     */
    .eq("provider_profile_id", "")
    .select("id")
    .maybeSingle();

  if (!fillError && !filled) {
    // Lost the race to fill. Our profile at the provider is the orphan now,
    // so it goes, and the winner's row is what this person gets.
    console.error("lost a race to record a browser profile", rowId);
    const removed = await deleteProfile(env, providerProfileId);
    if (removed.kind === "error") {
      console.error("could not delete an orphaned browser profile", removed.status);
    }
    const winner = await readProfileRow(db, userId);
    if (winner?.providerProfileId) {
      return {
        kind: "ok",
        value: {
          id: winner.id,
          providerProfileId: winner.providerProfileId,
          proxyCountryCode: winner.proxyCountryCode,
        },
      };
    }
    return { kind: "error", status: 409, message: TRY_AGAIN };
  }

  if (fillError) {
    // The provider now holds a jar nothing here can name, which is the exact
    // orphan the insert-first order exists to avoid — so it is deleted there
    // before the claim is handed back here.
    console.error("created a browser profile but could not record it", problem(fillError));
    const removed = await deleteProfile(env, providerProfileId);
    if (removed.kind === "error") {
      console.error("could not delete an orphaned browser profile", removed.status);
    }
    await handBackClaim(db, userId, rowId);
    return { kind: "error", status: 500, message: CANNOT_SET_UP };
  }

  return { kind: "ok", value: { id: rowId, providerProfileId, proxyCountryCode } };
}

const CANNOT_SET_UP =
  "could not set up the browser profile this sign-in needs. Nothing was saved, so trying " +
  "again is safe.";

const TRY_AGAIN = "a browser profile is already being set up for you — try that again in a moment";

/**
 * Give the unique index back.
 *
 * Narrowed to a row still naming no jar, because the one thing worse than a
 * stuck claim is deleting a profile row that has become real in the meantime —
 * the delete would cascade the person's takeovers with it.
 */
async function handBackClaim(db: SupabaseClient, userId: string, rowId: string): Promise<void> {
  const { error } = await db
    .from("browser_profiles")
    .delete()
    .eq("id", rowId)
    .eq("user_id", userId)
    .eq("provider_profile_id", "");
  if (error) console.error("could not hand back a browser profile claim", rowId, problem(error));
}

/**
 * Rent a browser and hand its live URL back once.
 *
 * Spec §4's order, and the order is the security of the route: refuse before
 * anything is created, create nothing until a slot is known to be free, and
 * stop anything that was created if the row cannot be written. Steps 0 to 2 —
 * refusing an API key, resolving the caller, and re-reading the task through
 * the caller's own client — belong to the route, where there is a caller for
 * RLS to resolve.
 */
export async function openTakeover(
  env: RoutineEnv,
  input: {
    userId: string;
    workspaceId: string;
    browserTaskId?: string | null;
    /**
     * What the profile is called at the provider. A label, not an identity:
     * whatever is passed leaves this deployment, and the only concession §4
     * argued for is the pseudonymous user id.
     */
    label?: string;
    /**
     * The egress to pin a NEW jar to — the request's own country, which the
     * route sources. Ignored when this person already has a jar, because the
     * egress a login was performed through cannot be changed afterwards
     * without invalidating it. See `ensureProfile`.
     */
    proxyCountryCode?: string | null;
  },
  overrides: Partial<TakeoverDeps> = {},
): Promise<OpenTakeoverResult> {
  const deps = resolve(env, overrides);
  const { db, now } = deps;

  /**
   * One open takeover per person — the time-aware half of the guard the
   * partial unique index cannot express, because `now()` is not immutable.
   *
   * A row that is `open` but past its window is not somebody's live browser;
   * it is a browser the provider may still be running and nobody has stopped.
   * Refusing on it would lock a person out of their own account for up to a
   * cron interval at exactly the moment they want back in, so it is closed
   * here and the sweep goes back to being the safety net rather than the only
   * way through.
   */
  const { data: standing, error: standingError } = await db
    .from("browser_takeovers")
    .select("id, profile_id, provider_session_id, expires_at")
    .eq("user_id", input.userId)
    .eq("status", "open")
    .maybeSingle();

  if (standingError) {
    console.error("could not look for an open takeover", problem(standingError));
    return {
      kind: "error",
      status: 500,
      message: "could not check for a browser you already have open",
    };
  }

  if (standing) {
    const expiresAt = Date.parse(String(standing.expires_at));
    // An unparseable window counts as past: letting somebody through is
    // recoverable, locking them out of their own account is not.
    if (Number.isFinite(expiresAt) && expiresAt > now().getTime()) {
      return {
        kind: "error",
        status: 409,
        message:
          "you already have a browser open. Finish signing in and press done in that one, or " +
          "wait for it to close, before opening another.",
      };
    }
    await closeStale(env, deps, {
      userId: input.userId,
      takeoverId: String(standing.id),
      profileId: String(standing.profile_id),
      providerSessionId: text(standing.provider_session_id),
    });
  }

  /**
   * Before the network, deliberately — `composio.ts:264-268`'s rule. With the
   * pool at ten, one person's login dialog could otherwise 429 every other
   * tenant's task for fifteen minutes, and their own re-run with it.
   */
  const headroom = await accountHeadroom(env);
  if (headroom.kind === "error") {
    console.error("could not read browser-use headroom", headroom.status);
    return {
      kind: "error",
      status: 502,
      message: "could not tell whether a browser is free to rent right now. Try again shortly.",
    };
  }
  if (headroom.value.active >= headroom.value.limit - POOL_RESERVE) {
    return {
      kind: "error",
      status: 429,
      message:
        "every browser this deployment can spare is busy. Try again in a few minutes — a " +
        "sign-in holds one for up to fifteen.",
    };
  }

  const profile = await ensureProfile(
    env,
    input.userId,
    { label: input.label ?? "Covan", proxyCountryCode: input.proxyCountryCode ?? null },
    deps,
  );
  if (profile.kind === "error") return profile;

  const browser = await createBrowser(env, {
    profileId: profile.value.providerProfileId,
    ...(profile.value.proxyCountryCode === null
      ? {}
      : { proxyCountryCode: profile.value.proxyCountryCode }),
  });

  if (browser.kind === "error") {
    // 429 here is the shared pool rather than a bug, and `browse` already
    // answers one in these words (`tools/browse.ts:157-164`).
    if (browser.status === 429) {
      return {
        kind: "error",
        status: 429,
        message: "every browser this deployment can run is busy. Try again in a few minutes.",
      };
    }
    console.error("browser-use would not rent a browser", browser.status);
    return {
      kind: "error",
      status: 502,
      message: "could not open a browser for you. Nothing was started, so trying again is safe.",
    };
  }

  const expiresAt = minutesFrom(now(), TAKEOVER_EXPIRY_MINUTES);
  const { data: row, error } = await db
    .from("browser_takeovers")
    .insert({
      user_id: input.userId,
      workspace_id: input.workspaceId,
      profile_id: profile.value.id,
      browser_task_id: input.browserTaskId ?? null,
      provider_session_id: browser.value.id,
      status: "open",
      // `liveUrl` is NOT here, and that is the point. See the file header.
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !row) {
    /**
     * A browser is running that nothing in this database can name: no sweep
     * will ever claim it, so it would hold a pool slot until the provider's
     * own timeout, with the person unable to stop it and unable to open
     * another. Stopped here, best effort, before the refusal goes back.
     */
    const stopped = await stopBrowser(env, browser.value.id);
    if (stopped.kind === "error") {
      console.error("could not stop a browser whose takeover row failed", stopped.status);
    }
    // `code` and `message`, never the object: PostgREST passes Postgres'
    // `DETAIL` through as `details`, and a CHECK violation's detail is
    // `Failing row contains (…)` — the whole row, including the
    // `provider_session_id` this insert carries. `expires_at > created_at` is
    // reachable on clock skew between this Worker and the database, since one
    // computes the window and the other defaults `created_at`. That is §4a's
    // second named path, "a log line becomes a live browser", and this closes
    // it structurally rather than by remembering.
    console.error("could not record a takeover", problem(error));
    // 23505 is one of the two unique indexes — a second request got there
    // first, which is a conflict and not a fault.
    const conflicted = error?.code === "23505";
    return {
      kind: "error",
      status: conflicted ? 409 : 500,
      message: conflicted
        ? "a browser was already opened for this. Use that one — reload the conversation to " +
          "get back to it."
        : "could not record the browser that was opened, so it was closed again. Trying again " +
          "is safe.",
    };
  }

  return { kind: "ok", id: String(row.id), liveUrl: browser.value.liveUrl, expiresAt };
}

/**
 * The moment the record becomes true, written once for both close paths.
 *
 * The stop is what saved the jar — *"profile state is only saved when the
 * session ends"* — so `provider_stopped_at` and the refreshed `cookie_domains`
 * belong to the same moment, and the route's close and the stale close must
 * not disagree about whether to record it. Task 4's sweep does the same thing
 * after its own stop, for the same reason.
 *
 * `cookieDomains` is null when the provider would not say, which is NOT an
 * empty jar: the browser stopped cleanly, so the cookies were persisted
 * whatever this read answered.
 */
async function recordStop(
  env: RoutineEnv,
  deps: TakeoverDeps,
  row: { userId: string; takeoverId: string; profileId: string },
): Promise<{ profile: TakeoverProfile; cookieDomains: string[] | null } | null> {
  const { db, now } = deps;
  const { userId, takeoverId } = row;

  /**
   * The profile is read BEFORE `provider_stopped_at` is written, which is the
   * opposite of the obvious order and the reason is the sweep.
   *
   * That timestamp is what takes a row out of the sweep's sight. Written
   * first, a failed read here would leave a `closed` row with the timestamp
   * set and the jar never refreshed — matching neither claim arm, so nothing
   * would ever revisit it, while the caller was told "this is retried
   * automatically". Read first and the failure leaves the null, so the sweep
   * does retry, one redundant stop being the whole cost.
   */
  const { data: profileRow, error: readError } = await db
    .from("browser_profiles")
    .select("id, provider_profile_id, proxy_country_code")
    .eq("id", row.profileId)
    .eq("user_id", userId)
    .maybeSingle();
  const providerProfileId = text(profileRow?.provider_profile_id);
  if (!profileRow || !providerProfileId) {
    // Logged with the error, because a transient read failure and a row that
    // is genuinely half-made are different problems with the same shape here.
    // Including that half-made row: `/profiles/` is not `/profiles/{id}`, so
    // an empty id must never reach the provider.
    console.error(
      "a takeover stopped with no profile row to refresh",
      takeoverId,
      problem(readError),
    );
    return null;
  }

  const { error: stopError } = await db
    .from("browser_takeovers")
    .update({ provider_stopped_at: now().toISOString() })
    .eq("id", takeoverId)
    .eq("user_id", userId);
  // Recorded, not fatal: the jar is saved either way, and the only cost of a
  // missing timestamp is one redundant stop on the next sweep tick.
  if (stopError)
    console.error("could not record a takeover's stop", takeoverId, problem(stopError));

  const refreshed = await getProfile(env, providerProfileId);
  const cookieDomains = refreshed.kind === "ok" ? refreshed.value.cookieDomains : null;
  if (cookieDomains) {
    const { error } = await db
      .from("browser_profiles")
      .update({ cookie_domains: cookieDomains, last_used_at: now().toISOString() })
      .eq("id", profileRow.id)
      .eq("user_id", userId);
    if (error) console.error("could not record a refreshed cookie jar", takeoverId, problem(error));
  } else if (refreshed.kind === "error") {
    console.error("stopped a takeover but could not read the jar back", refreshed.status);
  }

  return {
    profile: {
      id: String(profileRow.id),
      providerProfileId,
      proxyCountryCode: text(profileRow.proxy_country_code),
    },
    cookieDomains,
  };
}

/**
 * Close a window somebody walked away from, so the next one can open.
 *
 * Marked `closed` rather than `expired` on purpose: `expired` is the sweep's
 * own word for a row it claimed, and the sweep's retry arm looks for `closed`
 * with no `provider_stopped_at`. Writing `expired` here would take a refused
 * stop out of the sweep's sight and leave the browser running until the
 * provider's timeout with the jar unsaved.
 *
 * No settle loop, unlike the route's close: nobody is waiting on an answer
 * here and nothing is about to be re-run against the jar, so the stop the
 * provider accepted is all this path needs. That is the same thing the sweep
 * settles for.
 */
async function closeStale(
  env: RoutineEnv,
  deps: TakeoverDeps,
  row: { userId: string; takeoverId: string; profileId: string; providerSessionId: string | null },
): Promise<void> {
  const { db, now } = deps;
  const { userId, takeoverId, providerSessionId } = row;
  const { data: claimed } = await db
    .from("browser_takeovers")
    .update({ status: "closed", closed_at: now().toISOString() })
    .eq("id", takeoverId)
    // The lookup that found this row was already keyed to the caller; the
    // claim says so too, so no edit upstream can widen it by accident.
    .eq("user_id", userId)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  // Two requests racing to reopen: whoever lost does nothing, rather than
  // stopping a browser the winner has already replaced.
  if (!claimed || !providerSessionId) return;

  const stopped = await stopBrowser(env, providerSessionId);
  /**
   * A 200 is not a stop, and `status` is the difference.
   *
   * `PATCH {"action":"stop"}` can answer 200 with `status: "active"` — which is
   * the whole reason the route's close has a settle loop. Recording
   * `provider_stopped_at` on that answer would put this row outside BOTH arms
   * of `claim_due_browser_takeovers`: not `open`, and not missing its
   * timestamp. The browser would then run to its fifteen-minute timeout
   * holding a pool slot, with the abandoned jar this path exists to save lost
   * and no row left that could ever reclaim it.
   *
   * So anything short of `stopped` leaves the null and the sweep tries again,
   * which is exactly what this function's docblock says it is content with.
   * No settle loop here for that same reason: somebody is waiting on the
   * browser this is clearing the way for, and the sweep is the thing with
   * time.
   */
  if (stopped.kind === "error" || stopped.value.status !== "stopped") {
    console.error(
      "an expired takeover's browser did not stop",
      takeoverId,
      stopped.kind === "error" ? stopped.status : stopped.value.status,
    );
    return;
  }

  await recordStop(env, deps, { userId, takeoverId, profileId: row.profileId });
}

/**
 * Done: stop the browser, which is what saves the jar, and run the task again.
 *
 * Spec §6's five steps, in its order.
 *
 * 1. **Claim it by flipping the status**, and continue only if a row came
 *    back. Not a convenience: a double-click or a retried `fetch` runs this
 *    whole sequence twice and the person gets two assistant messages
 *    answering one question, minutes apart. `poller.ts:234-250` writes the
 *    same discipline down for the same reason.
 * 2. **Stop at the provider.** The only call that persists cookies.
 * 3. **Wait for `stopped`.** A 200 on the stop is not a promise that
 *    persistence finished, and re-running too early produces the one failure
 *    a person cannot interpret: they sign in, press done, and are told the
 *    page asked them to sign in.
 * 4. **Re-read the original task through the caller's own client**, and refuse
 *    the re-run if it is gone.
 * 5. **Re-run**, unless the refreshed `cookie_domains` is still empty — a
 *    sign-in that did not stick, and burning the one free retry on it would
 *    hand the person back the same login wall.
 *
 * **Steps 2 and 4 are swapped relative to spec §6, deliberately.** The spec
 * checks access before touching the provider, and that is wrong here: the
 * check refuses when the caller can no longer read the original task — they
 * were removed from the workspace, say — and that is a reason not to re-run a
 * task into a room they have left. It is not a reason to leave their browser
 * running. The stop saves *their own* cookie jar and ends Covan's billing at
 * once rather than up to a cron interval later, and by that point the row is
 * already claimed-closed, so somebody has to stop that browser either way.
 * Doing it here is strictly better than handing it to the sweep. A reader
 * comparing the two should find this disagreement argued rather than discover
 * it.
 *
 * **Step 1 and step 3 can disagree, and the design chooses step 1.** If the
 * provider refuses the stop after the row is already `closed`, the jar was not
 * saved and the browser keeps billing; if instead the row were left `open`,
 * the one-open index would lock the person out of their own account until the
 * next cron tick. So the row is closed regardless and `provider_stopped_at`
 * is written only on a confirmed stop, which is the state the sweep retries.
 */
export async function closeTakeover(
  env: RoutineEnv,
  input: {
    takeoverId: string;
    /**
     * The caller, as the route resolved it from the authenticated request.
     * Part of the claim's predicate rather than a label: `takeoverId` arrives
     * from a URL path, and this client answers to no policy. See the header.
     */
    userId: string;
    callerDb: SupabaseClient;
  },
  overrides: Partial<TakeoverDeps> = {},
): Promise<CloseTakeoverResult> {
  const deps = resolve(env, overrides);
  const { db, now, sleep } = deps;

  const { data: claimed } = await db
    .from("browser_takeovers")
    .update({ status: "closed", closed_at: now().toISOString() })
    .eq("id", input.takeoverId)
    // Somebody else's takeover is indistinguishable from an already-closed
    // one, which is the right answer to both: nothing claimed, nothing
    // stopped, no re-run.
    .eq("user_id", input.userId)
    .eq("status", "open")
    .select("id, user_id, workspace_id, profile_id, browser_task_id, provider_session_id")
    .maybeSingle();

  if (!claimed) {
    return { kind: "error", status: 409, message: "that takeover is already closed" };
  }

  const takeoverId = String(claimed.id);
  const providerSessionId = text(claimed.provider_session_id);
  const taskId = text(claimed.browser_task_id);

  if (!providerSessionId) {
    // Not reachable through 0077, which has the column `not null`. Said out
    // loud anyway, because the alternative is stopping nothing and reporting
    // a saved jar.
    console.error("a takeover row named no provider session", takeoverId);
    return { kind: "error", status: 500, message: CLOSE_FAILED };
  }

  const stopped = await stopBrowser(env, providerSessionId);
  if (stopped.kind === "error") {
    console.error("could not stop a takeover's browser", takeoverId, stopped.status);
    return { kind: "error", status: 502, message: CLOSE_FAILED };
  }

  let settled = stopped.value.status === "stopped";
  for (let attempt = 0; !settled && attempt < SETTLE_ATTEMPTS; attempt += 1) {
    await sleep(SETTLE_DELAY_MS);
    const state = await browserState(env, providerSessionId);
    if (state.kind === "error") {
      console.error("could not read a stopping browser's state", takeoverId, state.status);
      break;
    }
    settled = state.value.status === "stopped";
  }
  if (!settled) {
    // `provider_stopped_at` stays null, so the sweep finishes this.
    return { kind: "error", status: 504, message: CLOSE_FAILED };
  }

  /**
   * The jar is saved and the record says so, for both close paths. Written
   * before the access check below, because what it records is the stop that
   * just happened — not a decision about the re-run.
   */
  const settledJar = await recordStop(env, deps, {
    userId: input.userId,
    takeoverId,
    profileId: String(claimed.profile_id),
  });
  /**
   * Its own sentence, not `CLOSE_FAILED`.
   *
   * By here the stop was confirmed, so the sign-in IS saved — and the row
   * still has no `provider_stopped_at` (see `recordStop`), so the sweep will
   * revisit it. `CLOSE_FAILED` would be wrong in both directions at once:
   * falsely alarming about the sign-in, and on the old order falsely
   * reassuring about a retry that could never come.
   */
  if (!settledJar) {
    return {
      kind: "error",
      status: 500,
      message:
        "your sign-in is saved and the browser is closed, but the task could not be started " +
        "again. Asking for it again should work now.",
    };
  }
  const { profile, cookieDomains } = settledJar;

  /**
   * Now, and not before the stop: can this person still be answered?
   *
   * Gone means they lost access to the workspace between opening and closing,
   * and re-running would write a task into a session and an assistant message
   * into a conversation they can no longer see. So this refuses the re-run —
   * but it is not a reason to leave their browser running, which is why it
   * moved below the stop.
   */
  let original: RetryableTask | null = null;
  if (taskId) {
    const { data } = await input.callerDb
      .from("browser_tasks")
      .select("id, workspace_id, agent_id, user_id, session_id, task, retry_of")
      .eq("id", taskId)
      .maybeSingle();
    if (!data) {
      return {
        kind: "error",
        status: 404,
        message:
          "the task this browser was opened for is no longer available to you, so it was not " +
          "run again. Your sign-in was saved and the browser is closed.",
      };
    }
    original = data as RetryableTask;
  }

  if (cookieDomains && cookieDomains.length === 0) {
    return {
      kind: "ok",
      retriedTaskId: null,
      cookieDomains: [],
      message:
        "that sign-in didn't stick — the browser closed with no cookies saved, so the task " +
        "was not run again. Opening another browser and signing in fully will.",
    };
  }

  if (!original) {
    return {
      kind: "ok",
      retriedTaskId: null,
      cookieDomains: cookieDomains ?? [],
      message: "your sign-in is saved. Nothing was waiting on it, so nothing was run.",
    };
  }

  const retriedTaskId = await retryBrowserTask(
    env,
    original,
    profile.providerProfileId,
    profile.proxyCountryCode,
  );
  if (!retriedTaskId) {
    return {
      kind: "error",
      status: 502,
      message:
        "your sign-in is saved, but the task could not be started again. Asking for it again " +
        "should work now.",
    };
  }

  return {
    kind: "ok",
    retriedTaskId,
    cookieDomains: cookieDomains ?? [],
    message: "your sign-in is saved and the task is running again.",
  };
}

const CLOSE_FAILED =
  "the browser could not be closed cleanly, so your sign-in may not be saved yet and the task " +
  "was not run again. This is retried automatically within a few minutes.";

/**
 * Run the original task once more, with the jar attached, for free.
 *
 * **Nothing here consults the allowance, and that is the whole point.**
 * `browse` charged `BROWSER_TASK_TOKENS` when the task was first asked for,
 * and a login wall is not something the person did wrong — so this path
 * deliberately touches neither `spend` nor `affordable` nor anything in
 * `lib/entitlements`. What keeps that from being an unbounded operator spend
 * is `retry_of`: one retry per original task, ever, and the card's offerable
 * predicate refuses to offer takeover for a task that already has a
 * successor.
 *
 * **A new row rather than reviving the old one.** The old row stays terminal
 * and cannot be claimed twice: the poller's partial index excludes terminal
 * statuses, and a revived row would re-enter the claim set with a `poll_count`
 * already near `MAX_POLLS`.
 *
 * **One retry per original, and a retry is never itself retried.** The guard
 * below costs one comparison and sits beneath two other things that say the
 * same: `browser_tasks_retry_of_idx` is unique, so the database refuses a
 * second successor outright, and Task 5's offerable predicate never offers
 * takeover for a row that already has one. Three because what it bounds is
 * the operator's money on a path that consults no allowance.
 *
 * **Why the provider is called before the row is written, which is the
 * opposite of `ensureProfile`.** The ordering hazard
 * `recordBrowserTask`'s header describes — money spent at the provider on a
 * task nothing will poll — is real here too, and it is accepted rather than
 * missed, because the alternative is worse: an insert-first order would need a
 * placeholder `provider_task_id`, a sentinel on a column the poller addresses
 * a running browser with. What makes the race `ensureProfile` guards against
 * impossible here is `closeTakeover`'s status-flip claim: this function is
 * reached only from inside a sequence that one request has already won, so
 * there is no second caller to duplicate. And if that reasoning ever stops
 * holding, the unique index is the backstop — the second insert fails instead
 * of double-spending.
 *
 * Every id copied here was resolved from an authenticated request when the
 * original was created, and the caller's own client is what read this row back
 * — so nothing new is being trusted.
 */
export async function retryBrowserTask(
  env: RoutineEnv,
  original: RetryableTask,
  providerProfileId: string,
  proxyCountryCode: string | null,
): Promise<string | null> {
  if (original.retry_of) {
    // A second wall is a conversation, not another free attempt.
    console.error("refused to retry a task that is already a retry", original.id);
    return null;
  }

  const created = await createTask(env, {
    task: original.task,
    profileId: providerProfileId,
    // Pinned at the profile and reused: cookies are bound to the egress the
    // login happened from, and a different one invalidates the session.
    ...(proxyCountryCode === null ? {} : { proxyCountryCode }),
  });

  if (created.kind === "error") {
    console.error("could not start the re-run after a takeover", original.id, created.status);
    return null;
  }

  return recordBrowserTask(env, {
    workspaceId: original.workspace_id,
    agentId: original.agent_id,
    userId: original.user_id,
    sessionId: original.session_id,
    providerTaskId: created.value.id,
    task: original.task,
    retryOf: original.id,
  });
}
