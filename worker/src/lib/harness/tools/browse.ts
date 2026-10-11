import { hasBrowserKey } from "../../browser/client";
import {
  credentialsFor,
  savedLogin,
  siteHostOf,
  type CredentialBinding,
} from "../../browser/credentials";
import { conversationRun, jarForRun } from "../../browser/outcome";
import {
  ensureBrowserSession,
  recordRunStart,
  releaseBrowserSession,
} from "../../browser/sessions";
import { stopDeclinedBrowser } from "../../browser/profiles";
import { recordBrowserTask } from "../../browser/tasks";
import { profileFor, runProfile } from "../../browser/takeover";
import { createRun } from "../../browser/v4";
import { BROWSER_TASK_TOKENS, entitlementsFor } from "../../entitlements";
import { affordable, spend, wasBilled } from "../spend";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * A web page, opened by somebody else's browser.
 *
 * This is the one tool in the registry that does not answer the question it
 * was asked. It hands the work to browser-use, records where the answer has
 * to come back to, and returns a task id — and then the turn ENDS.
 *
 * **That is the design, and it is the part most likely to be undone by
 * somebody trying to be helpful.** A version of this tool that waited would
 * burn the step budget polling (`MAX_STEPS` is 8 on Workers Free), and every
 * poll's result would re-enter the transcript and be re-sent on every later
 * pass — so cost would grow with the SQUARE of the poll count, which is the
 * one cost shape `lib/harness/budget.ts` exists to refuse. A browser task
 * takes minutes. Minutes do not fit in a chat turn. Polling belongs outside
 * the model loop, and it lives in `lib/browser/poller.ts`.
 *
 * **One instruction, deliberately.** Not a URL plus a goal, not a step list.
 * The provider's own agent decomposes a sentence; a second instruction would
 * be Covan second-guessing a loop it did not write. It is also what makes the
 * approval card honest: with no endpoint, no method and no origin to inspect,
 * the sentence IS the blast radius, so one sentence is the whole of what a
 * person is shown and the whole of what they agree to.
 *
 * **`site` is not a second instruction (Task 2.3).** It names which saved
 * login, if any, the run may carry — a host, checked to be one, and shown on
 * the card as the login it selects ("signs in as linkedin.com (saved login:
 * …)") so it is agreed to as visibly as the sentence. It does not steer the
 * browser, and it never decides where the password may be typed: that is the
 * saved row's own `site_host`, in the bindings `credentialsFor` builds
 * (Review focus 4). A model talked into naming the wrong site gets that site's
 * login typed on that site only, and the card said so before anyone agreed.
 *
 * **No `needs`, and that is the direct lesson of the Composio attempt.** A
 * browser task points at the public web, not at a tenant's connected
 * service — so there is no `tool_connections` row, no catalogue lookup and no
 * connection id. The connection-and-catalogue machinery was the entire source
 * of that breakage; none of it is needed here.
 *
 * **One browser per conversation, since 0078.** Each call is one v4 RUN
 * inside the conversation's agent session at the provider, so a follow-up
 * continues in the tabs the last one left, and the person watches that browser
 * in a panel beside the chat and can take it over. `lib/browser/sessions.ts`
 * keeps the session; this file only decides whether a run opens one or
 * continues it.
 */

/** Shorter than this is not a task, it is a word. Matches the schema's `minLength`. */
const MIN_TASK_CHARS = 10;

/**
 * What the model is told when this conversation's browser is already busy.
 *
 * One v4 session runs one run at a time — *"A busy V4 session returns 409"* —
 * and a second browser for the same conversation is exactly what the session
 * row exists to prevent. So the second request waits for the first one's
 * answer, and the model is told so in words that stop it asking again.
 */
const STILL_RUNNING =
  "a browser task is still running in this conversation, and its browser does one thing at a " +
  "time. Its answer will arrive as a new message; tell the person that, and do not retry this " +
  "turn.";

/**
 * What the model is told while the person is driving the browser themselves.
 *
 * A run created now would take the controls out of their hands mid-sign-in;
 * the hand-back (their Done) is what gives the browser to the agent again.
 */
const IN_THEIR_HANDS =
  "the person is using the browser right now, in the panel beside this conversation. The " +
  "agent continues when they press Done there; tell them that, and do not retry this turn.";

export { BROWSER_TASK_TOKENS };

/**
 * What the card says this browser carries, or nothing.
 *
 * One human sentence, for `allowanceNote`'s reason: the card renders fields
 * as rows, and a row reading `cookieDomains: ["mail.google.com"]` is a row
 * that tells nobody what it means.
 *
 * **It does not say "signed in to", and that correction came from the first
 * real run.** A single hand-performed LinkedIn sign-in left the provider
 * reporting seven domains: `linkedin.com` and `linkedin-ei.com`, and then
 * `facebook.com`, `google.com`, `demdex.net`, `33across.com` and
 * `protechts.net` — ad-tech cookies a page drops while loading. "This browser
 * is signed in to facebook.com" was false, alarming, and read like a
 * confession that Covan was holding somebody's Facebook session.
 *
 * The truncation made it worse: at four names and "and 3 more", the one domain
 * the person had actually signed into was the one cut off. So the count leads
 * now, and the sentence says what the list is.
 *
 * Read through the caller's own client on purpose, even though the profile
 * was just resolved with the service role. `browser_profiles` grants
 * `authenticated` a select on `cookie_domains` and withholds
 * `provider_profile_id` (0077) — so this reads the one column a screen may
 * show, through the policy that says it may. Null when there is no jar or
 * nothing in it, which is the ordinary case and not worth a row.
 */
async function jarNote(ctx: ToolContext, profile: { id: string } | null): Promise<string | null> {
  if (!profile) return null;
  try {
    const { data } = await ctx.db
      .from("browser_profiles")
      .select("cookie_domains")
      .eq("id", profile.id)
      .maybeSingle();
    const domains = Array.isArray(data?.cookie_domains)
      ? (data.cookie_domains as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    if (domains.length === 0) return null;
    const shown = domains.slice(0, 5).join(", ");
    const sites = domains.length === 1 ? "1 site" : `${domains.length} sites`;
    return domains.length > 5 ? `${sites}, including ${shown}` : `${sites}: ${shown}`;
  } catch {
    // A card that cannot say this is better than a turn that fails over it.
    return null;
  }
}

/**
 * What the card says a task costs, or nothing at all.
 *
 * Returned as one human sentence rather than a number, because the proposal
 * card renders fields as rows and "cost: 137000" is a row that tells nobody
 * anything. A task is about 14% of a month, which is a big enough bite that
 * somebody should see it before saying yes.
 *
 * Null on an unmetered deployment — `limit: null` is the interface's way of
 * saying no quota exists — and null if the read fails. Never a guess: a made
 * up share on a self-hosted install would be a sentence about a ceiling that
 * is not there.
 */
async function allowanceNote(ctx: ToolContext): Promise<string | null> {
  try {
    const { used, limit } = await entitlementsFor(ctx.env).snapshot(ctx.userId);
    if (!limit) return null;
    const share = Math.round((BROWSER_TASK_TOKENS / limit) * 100);
    const left = Math.max(0, Math.floor((limit - used) / BROWSER_TASK_TOKENS));
    return (
      `about ${share}% of this month's allowance ` +
      `(${left} browser ${left === 1 ? "task" : "tasks"} left after this one)`
    );
  } catch (err) {
    // Advisory. A person who cannot be told the price should still be asked
    // the question — the alternative is a tool that stops working because a
    // counter is down.
    console.error("could not read the allowance for a browser task", err);
    return null;
  }
}

/** `siteOf`'s answer for a `site` that is there and is not a host. */
const INVALID_SITE = Symbol("invalid site");

/**
 * The `site` argument as the host a saved login is filed under, null when the
 * model named none, or `INVALID_SITE`.
 *
 * Normalised by `siteHostOf`, the very function a saved `site_host` went
 * through (R25), so `https://www.LinkedIn.com/login` finds the login saved as
 * `linkedin.com` — and there is no second normaliser here to drift from it. A
 * blank string is no site: some models fill every optional field, and a task
 * that needs no sign-in must not be refused for an empty one.
 */
function siteOf(raw: unknown): string | null | typeof INVALID_SITE {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return INVALID_SITE;
  if (!raw.trim()) return null;
  return siteHostOf(raw) ?? INVALID_SITE;
}

/**
 * What the card says the browser will sign in with, or nothing.
 *
 * `"linkedin.com (saved login: LinkedIn — sales account)"`: the host the login
 * is typed on, and the saver's own name for it — never the username, which is
 * encrypted precisely because it is often the more personal half, and which a
 * colleague approving a shared agent's task has no business reading. Through
 * `savedLogin`, which names the login without opening it: a card somebody
 * declines must decrypt nothing and mark nothing used.
 *
 * Null when nothing is saved for the site, and null if the read fails — the
 * question is still worth asking without the row, as with `jarNote`.
 */
async function loginNote(ctx: ToolContext, site: string): Promise<string | null> {
  try {
    const login = await savedLogin(ctx.env, {
      agentId: ctx.agentId,
      userId: ctx.userId,
      host: site,
    });
    return login ? `${login.siteHost} (saved login: ${login.label})` : null;
  } catch {
    console.warn("could not read the saved logins for a browser task's card");
    return null;
  }
}

/**
 * The saved login a run on `site` carries, or null.
 *
 * A read that fails is a run without the login, not a run that does not
 * start: it meets the login wall and says so, which the person can fix in the
 * panel. Logged as a fixed sentence and nothing else — the error names a table
 * and a code today, and this line must stay safe whatever it names tomorrow.
 */
async function loginFor(ctx: ToolContext, site: string): Promise<CredentialBinding | null> {
  try {
    return await credentialsFor(ctx.env, {
      agentId: ctx.agentId,
      userId: ctx.userId,
      host: site,
    });
  } catch {
    console.warn("could not read the saved logins for a browser task; running without one");
    return null;
  }
}

export const browseTool: AgentTool = {
  name: "browse",
  description:
    "Do something on a web page: read a page that needs JavaScript, pull a number out of a " +
    "site with no API, follow a few links and report back. You give ONE instruction in plain " +
    "language and a real browser carries it out elsewhere. This does not answer you now — it " +
    "starts the work and comes back with the answer as a new message in a few minutes, so say " +
    "that you have started it and do not wait or ask again. The browser may carry sign-ins the " +
    "person performed themselves, in their own hands, in an earlier takeover. You are never " +
    "shown a password: when the task has to sign in to a site, put that site's host in `site` " +
    "and, if the person saved a login for it, the browser is given it to type in itself. The " +
    "browser opens beside the conversation, where the person can watch it and take over at any " +
    "time. Use http_request instead when the thing you want has an API.",
  input: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: MIN_TASK_CHARS,
        description:
          "One instruction, in plain language, naming the site and what to get or do. " +
          "The person is shown this sentence word for word and has to approve it.",
      },
      site: {
        type: "string",
        description:
          "The host whose saved login the task needs, like linkedin.com — only when it has to " +
          "sign in there; leave it out otherwise.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  destructive: true,
  // No `needs`: there is no connection and no channel for this to point at.
  isConfigured: (env: ToolEnv) => hasBrowserKey(env),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { task?: unknown; site?: unknown };
    if (typeof input.task !== "string" || !input.task.trim()) {
      return { kind: "error", message: "task is required" };
    }
    const task = input.task.trim();
    if (task.length < MIN_TASK_CHARS) {
      return {
        kind: "error",
        message: "say what to do in one sentence — which site, and what to get or do there",
      };
    }
    const site = siteOf(input.site);
    if (site === INVALID_SITE) {
      // Before the card and before the meter (ruling R13's order): a refusal
      // costs nothing and leaves nothing behind.
      return {
        kind: "error",
        message:
          "site must be the bare host of a website, like linkedin.com — or leave it out when " +
          "the task does not need to sign in anywhere",
      };
    }

    /**
     * Nobody is watching a scheduled run, and the answer to a browser task
     * arrives minutes later as a message in a conversation. A routine has no
     * conversation to arrive in, which is the same thing `paused_turns` says
     * by making `session_id` not null (0060:124-128). So this is an honest
     * failure rather than a task whose answer has nowhere to go.
     */
    if (!ctx.sessionId) {
      return {
        kind: "error",
        message:
          "a browser task reports back into a conversation and a scheduled run has none, so " +
          "this cannot be done unattended. Say so plainly rather than retrying.",
      };
    }

    /**
     * Whose cookie jar this browser will carry, resolved from `ctx.userId`.
     *
     * **Not threaded through `ToolContext`.** Adding a field there would mean
     * a profile query on every chat turn, for a feature most turns never
     * touch. The id still derives from `ctx` — the route resolved it from the
     * authenticated request before the tool ran — and the model never sees it
     * or names it. Same shape and same reason as the `recordBrowserTask`
     * call below.
     *
     * Null for somebody who has never run a browser task: the card then says
     * nothing about a jar, because there is none, and the approved run
     * provisions one (ruling R19, below). Read here, before the card, rather
     * than provisioned here, because a proposal somebody declines must leave
     * nothing behind — a profile at the provider least of all.
     */
    const profile = await profileFor(ctx.env, ctx.userId);

    if (ctx.confirmed !== true) {
      const cost = await allowanceNote(ctx);
      /**
       * Which sites this browser is signed into, on the card.
       *
       * Without it somebody approves "check the FT front page" and an
       * arbitrary page gets 25 steps *inside their signed-in session*, with
       * the card saying nothing about that. `ProposalRows` iterates
       * `Object.entries(proposal)` and skips only `kind`, so this renders
       * with no frontend change — the same free ride `cost` already takes.
       *
       * `cookie_domains` is the provider's own list and the whole of what
       * Covan can say about somebody's logins, because Covan holds none of
       * them. Named `cookies` rather than `signedInTo`: the key IS the row's
       * label, and the list is cookie domains — most of which a page dropped
       * rather than a person signed into. See `jarNote`.
       */
      const cookies = await jarNote(ctx, profile);
      const signsInAs = site ? await loginNote(ctx, site) : null;
      return {
        kind: "needs_confirmation",
        summary: "Use a browser to do this?",
        proposal: {
          kind: "browse",
          // Verbatim, and untruncated. §4: this sentence is the entire
          // description of what is being authorised.
          task,
          ...(cost ? { cost } : {}),
          ...(cookies ? { cookies } : {}),
          ...(signsInAs ? { signsInAs } : {}),
        },
      };
    }

    // Before the network, because a browser task is real money at a third
    // party and an exhausted account must not be able to start one. See
    // `lib/harness/spend.ts`.
    const refused = await affordable(ctx);
    if (refused) return refused;

    /**
     * This conversation's browser, found or claimed BEFORE the provider is
     * called — `ensureProfile`'s order, for the reason 0078 gives the unique:
     * two first requests that both opened a session would leave one browser
     * nothing in this database names. After the approval rather than before,
     * so a proposal somebody declines leaves no row behind.
     */
    const session = await ensureBrowserSession(ctx.env, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      chatSessionId: ctx.sessionId,
      profileId: profile?.id ?? null,
    });
    if (session.kind === "error") {
      // Nothing reached the provider, so nothing is charged.
      return {
        kind: "error",
        message:
          session.status === 409
            ? STILL_RUNNING
            : "could not open a browser for this conversation just now. Say so plainly and " +
              "offer to try again; do not retry this turn.",
      };
    }
    /**
     * Ruling R13: two refusals read off the row, before the provider is
     * called and so before the meter, which charges nothing until the
     * provider has answered. Neither hands the claim back — a row that is in
     * somebody's hands or mid-run names a live browser. The 409 below stays
     * as the backstop for a run that starts between this read and ours.
     */
    if (session.value.liveState === "human") return { kind: "error", message: IN_THEIR_HANDS };
    if (session.value.runInFlight) return { kind: "error", message: STILL_RUNNING };

    /**
     * Ruling R19: a person with no jar gets one now, so what they sign in to
     * in the panel has a profile to be saved into when the browser stops.
     * After the refusals above, because a refusal must cost nothing, and
     * before the run, which carries it. Once per person: `runProfile` is
     * `ensureProfile`'s claim-first order, so racing first runs make one
     * profile. A failure answers null and the run goes ahead without a jar,
     * exactly as it did before this existed.
     *
     * Subrequests: nothing for a person who has a jar (`profileFor` above
     * already read it). The first time, four — the re-read, the claim, the
     * provider's create and the fill — once per person, ever.
     */
    const jar = profile ?? (await runProfile(ctx.env, ctx.userId));

    const continuing = session.value.providerSessionId;
    const opening = continuing === null;

    // The preamble, the schema, the model and the cost ceiling are
    // `conversationRun`'s, shared with the hand-back so the two cannot drift.
    // A follow-up continues the browser this conversation already has; a
    // first run names no session and the provider opens one.
    /**
     * The saved login for `site`, if there is one this person may use (Task
     * 2.3). After the refusals, so a refused browse decrypts nothing, and on
     * every run that names the site — the provider's bindings are run-scoped,
     * so a follow-up that needs the login carries it again. `conversationRun`
     * puts the bindings in the body and the sentence naming their aliases in
     * the task; nothing else in this function ever holds a value.
     */
    const login = site ? await loginFor(ctx, site) : null;
    // A follow-up names the jar only when its browser was opened with it; see
    // `jarForSession` for the provider's rule. And a run carrying a shared
    // login carries no jar at all (ruling R38): see `jarForRun`.
    const {
      profile: sent,
      withoutProfile,
      detach,
    } = jarForRun(jar, { opening, openedWith: session.value.profileId }, login);
    const created = await createRun(
      ctx.env,
      conversationRun(ctx.env, {
        task,
        sessionId: continuing,
        profile: sent,
        withoutProfile,
        login,
      }),
      { signal: ctx.signal },
    );

    if (created.kind === "error") {
      // A run that never started opened nothing, so the claim goes back —
      // otherwise every `browse` in the next minute is told to wait for it.
      // A follow-up's row names a live browser and is left alone.
      if (opening) await releaseBrowserSession(ctx.env, session.value.id);
      // 429 is the concurrency pool, which is account-wide and shared across
      // every tenant on this deployment — ten sessions at $0 lifetime spend.
      // v1 refuses and says so; a queue is a later problem with real numbers
      // behind it.
      if (created.status === 429) {
        return {
          kind: "error",
          message:
            "every browser this deployment can run is busy. Say so and offer to try again in a " +
            "few minutes; do not retry this turn.",
        };
      }
      // Charged only when they took the request. `wasBilled` is the existing
      // rule for which failures are somebody's money — and a 409 counts, as
      // every other provider error does (ruling R12): this is the path it
      // has always taken, with only the sentence changed.
      if (wasBilled(created.status) && created.status !== 0) {
        await spend(ctx, BROWSER_TASK_TOKENS);
      }
      // Not retried, and never a second session: the busy one is this
      // conversation's browser, mid-run.
      if (created.status === 409) return { kind: "error", message: STILL_RUNNING };
      // `created.message` is a status line and never the provider's body:
      // `createRun` sends with `redactBody: true`, and a body that echoed this
      // request would echo a saved login's bindings into
      // `message_steps.result_excerpt`. Pinned in `browse.test.ts`.
      return { kind: "error", message: `could not start the browser task: ${created.message}` };
    }

    /**
     * The row is written BEFORE the charge, and that order is the point: a
     * task at the provider that nothing in this database knows about is money
     * spent on work whose answer can never be delivered. If the write fails
     * the honest thing is to say so and charge nothing — the browser will run
     * and nobody will read it, which is bad, but charging for it as well
     * would be worse.
     *
     * **Through the service role, not `ctx.db`.** `0073` gives
     * `browser_tasks` no write grant for any client role, so the first
     * version of this — an insert through the caller's own client — answered
     * `42501 permission denied` after the task had already been created at
     * browser-use. `lib/browser/tasks.ts` carries the argument for why the
     * grant stays shut rather than being relaxed.
     */
    const recorded = await recordBrowserTask(ctx.env, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      // The person's sentence, not the preamble: it is what the answer is
      // delivered against and what a take-over runs again.
      task,
      providerRunId: created.value.id,
      browserSessionId: session.value.id,
      // Ruling R32: the saved login this run carried, so a login wall
      // afterwards is blamed on it — and on nothing the run was never given.
      // The same condition `conversationRun` puts the bindings in the body on.
      ...(login?.bindings.length ? { credentialId: login.id } : {}),
    });

    if (!recorded) {
      return {
        kind: "error",
        message:
          "the browser task started but could not be recorded, so its answer cannot be " +
          "delivered. Say that plainly and do not start another.",
      };
    }

    // The agent has the controls, and a first run's session is now this
    // conversation's browser. Logged rather than failed if it cannot be
    // written: the run is real and its answer will still arrive.
    await recordRunStart(ctx.env, {
      browserSessionId: session.value.id,
      ...(opening ? { providerSessionId: created.value.sessionId } : {}),
      // The jar this run carries, which the claim could not name when it was
      // provisioned just now. See `recordRunStart`. Only by the run that
      // opens the browser: a follow-up's browser keeps the jar it was opened
      // with, and the row must not say otherwise. A shared login's run takes
      // the jar off the row instead (R38): the claim above named the jar
      // before the login was known, and a detached follow-up's browser is a
      // fresh one without it.
      ...(detach ? { providerBrowserId: null } : {}),
      ...(withoutProfile ? { profileId: null } : sent && opening ? { profileId: sent.id } : {}),
    });

    /**
     * Ruling R41: the profiled browser this run declined (`detach`) is stopped
     * — after the write above, which already made the row forget it, so the
     * panel and the settle converge on the new browser first. Stopping it is
     * also what saves the person's jar (*"always stop the session to persist
     * profile state"*). Best-effort: a refusal logs a status, the run is real,
     * and the sweeps stop every active browser of the session anyway.
     *
     * Subrequests: one more, on this path only — a shared login's follow-up
     * into a browser opened with the person's jar (the stop). Every other
     * `browse` spends what it did.
     */
    if (detach) {
      await stopDeclinedBrowser(ctx.env, session.value.providerBrowserId ?? null, {
        signal: ctx.signal,
      });
    }

    await spend(ctx, BROWSER_TASK_TOKENS);

    return {
      kind: "ok",
      content:
        "Started. A browser is doing this now and it usually takes a few minutes. The answer " +
        "will arrive as a new message in this conversation — tell the person that and finish " +
        "your reply. Do not call browse again for this.",
    };
  },
};
