import { hasBrowserKey } from "../../browser/client";
import { savedLogin, siteHostOf } from "../../browser/credentials";
import { QUEUE_MAX, queueBrowserTask, waitingInLine } from "../../browser/queue";
import { ensureBrowserSession, releaseBrowserSession } from "../../browser/sessions";
import { beginConversationRun, finishRunStart } from "../../browser/start";
import { recordBrowserTask } from "../../browser/tasks";
import { heldTakeover, profileFor } from "../../browser/takeover";
import { entitlementsFor } from "../../entitlements";
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
 * What the model is told when its task has been put in the browser's line
 * (0080) instead of started. Not an error: the task will run, by itself, and
 * the model's job is to say so and stop — a model that called `browse` again
 * would queue the same task twice.
 */
function queuedFor(position: number): string {
  return (
    `Queued: this conversation's browser is busy, so this task is number ${position} in line ` +
    "and starts by itself when the ones before it are done. Its answer will arrive as a new " +
    "message in this conversation, after theirs. Tell the person that and finish your reply. " +
    "Do not call browse again for this."
  );
}

/** What the model is told when the line is full (`QUEUE_MAX`). */
const QUEUE_FULL =
  `${QUEUE_MAX} browser tasks are already waiting for this conversation's browser, which runs ` +
  "them one at a time. Tell the person it will do those first, and offer to ask for this one " +
  "once they are done; do not retry this turn.";

/**
 * A task as the card lists it below the first one: one line, so the card can
 * number it and the confirm route can read it back. Null for a task the
 * first card cannot speak for — one too short to run, or one that signs in
 * with a saved login, which its own card has to name (`signsInAs`).
 */
function lineOf(args: Record<string, unknown>): string | null {
  if (typeof args.task !== "string" || args.site !== undefined) return null;
  const line = args.task.replace(/\s+/g, " ").trim();
  return line.length >= MIN_TASK_CHARS ? line : null;
}

/** The numbered list under the first task, from 2 because the card's own is 1. */
const LISTED = /^\d+\. (.+)$/;

const CANNOT_TELL_LINE =
  "could not check what this conversation's browser already has waiting, so the task was not " +
  "started. Say so plainly and offer to try again; do not retry this turn.";

/**
 * What the model is told while the person is driving the browser themselves.
 *
 * A run created now would take the controls out of their hands mid-sign-in;
 * the hand-back (their Done) is what gives the browser to the agent again.
 */
const IN_THEIR_HANDS =
  "the person is using the browser right now, in the panel beside this conversation. The " +
  "agent continues when they press Done there; tell them that, and do not retry this turn.";

/**
 * What the model is told while the person has a browser of their own open —
 * the one they open from the chat header to sign in ahead of time (Task 3.1).
 *
 * It runs on the same cookie jar this run would carry, and whichever browser
 * stops last writes the jar (ruling R44), so a run now could overwrite the
 * sign-in they are in the middle of making. Their Done is what saves it.
 */
const OWN_BROWSER_OPEN =
  "the person has a browser of their own open right now, signing in to sites. Ask them to " +
  "press Done in the browser they opened first, so the sign-in is saved before the agent " +
  "uses it; tell them that, and do not retry this turn.";

const CANNOT_TELL =
  "could not check whether the person's own browser is open, so the browser was not started. " +
  "Say so plainly and offer to try again; do not retry this turn.";

/**
 * What the card says this browser carries, or nothing.
 *
 * One human sentence, for `creditNote`'s reason: the card renders fields
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
 * What the card says about credits, or nothing at all.
 *
 * Returned as one human sentence rather than a number, because the proposal
 * card renders fields as rows and "balance: 412.3" is a row that tells nobody
 * anything. A browser task is the dearest single thing an agent can do, so the
 * balance is worth seeing before saying yes. What one task costs is not said:
 * it is the provider's figure, known only when the run ends.
 *
 * Null on an unmetered deployment and on a house workspace — there is no
 * balance to show — and null if the read fails. Never a guess: a made-up
 * figure on a self-hosted install would be a sentence about a ceiling that is
 * not there.
 */
async function creditNote(ctx: ToolContext): Promise<string | null> {
  try {
    const credits = await entitlementsFor(ctx.env).snapshot(ctx.workspaceId);
    if (!credits.metered || credits.unlimited) return null;
    const left = Math.max(0, Math.floor(credits.balance));
    return `uses credits; this workspace has ${left} ${left === 1 ? "credit" : "credits"} left`;
  } catch (err) {
    // Advisory. A person who cannot be told the balance should still be asked
    // the question — the alternative is a tool that stops working because a
    // ledger is down.
    console.error("could not read the credit balance for a browser task", err);
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

/** How many hosts named in a task are asked about: three reads at most, per proposal. */
const TASK_HOSTS_ASKED = 3;

/**
 * The hosts a task names, as a saved `site_host` would be filed: from URLs
 * (`https://quotes.toscrape.com/login`) and from bare names (`linkedin.com`),
 * in the order they appear, at most `TASK_HOSTS_ASKED`.
 */
function hostsIn(task: string): string[] {
  const found: string[] = [];
  const named = /\bhttps?:\/\/[^\s"'<>()[\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
  for (const match of task.matchAll(named)) {
    const host = siteHostOf(match[0]);
    if (host && !found.includes(host)) found.push(host);
    if (found.length === TASK_HOSTS_ASKED) break;
  }
  return found;
}

/**
 * The site whose saved login a task needs, when the model named none.
 *
 * Found in the 2026-10-11 e2e: gpt-4.1-mini never filled `site`, not even for
 * "Please try again with my saved login" — its own task said "using the saved
 * login credentials" and the run carried none. So a login saved for a site was
 * unusable in any conversation but the one it was saved in, and the wall's
 * "ask again" became a loop.
 *
 * So when `site` is absent, the first host the task names that has a login
 * this person may use (`savedLogin`, the card's own lookup) stands in for it.
 * This decides only WHICH saved login the run may carry, never where it may
 * be typed — that stays the row's own `site_host`, in the bindings
 * `credentialsFor` builds (Review focus 4) — and it is shown on the card as
 * `signsInAs` exactly as a named `site` is, so the person approves it. A task
 * steered to name a site gets that site's login typed on that site only, and
 * the card said so first.
 *
 * Asked the same way for the card and for the approved run (the same task
 * text), so the two agree. A read that fails is no site: the run meets the
 * wall and the panel offers the login from there.
 */
async function siteFromTask(ctx: ToolContext, task: string): Promise<string | null> {
  for (const host of hostsIn(task)) {
    try {
      const login = await savedLogin(ctx.env, {
        agentId: ctx.agentId,
        userId: ctx.userId,
        host,
      });
      // The task's host, as a model's `site` would be: `savedLogin` and
      // `credentialsFor` both walk up from it to the saved row (R37).
      if (login) return host;
    } catch {
      console.warn("could not read the saved logins for a browser task's sites");
      return null;
    }
  }
  return null;
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
 * Whether the login `site` would carry is a shared one, while the person's own
 * browser jar already holds cookies for that site or a parent of it.
 *
 * The jar's domains are the provider's list, which includes ad-tech a page
 * dropped — so this can hold back a shared login for a site the person never
 * signed into themselves. That errs toward the person's own session, and the
 * login wall that may follow offers the shared login from the panel, on a
 * screen that names it. A read that fails is "no": the card still names
 * whatever login is attached.
 */
async function sharedLoginOverOwnJar(
  ctx: ToolContext,
  profile: { id: string; cookieDomains?: string[] } | null,
  site: string,
): Promise<boolean> {
  if (!profile) return false;
  try {
    const login = await savedLogin(ctx.env, {
      agentId: ctx.agentId,
      userId: ctx.userId,
      host: site,
    });
    if (!login || login.scope !== "agent") return false;
    const { data } = await ctx.db
      .from("browser_profiles")
      .select("cookie_domains")
      .eq("id", profile.id)
      .maybeSingle();
    const jar = Array.isArray(data?.cookie_domains)
      ? (data.cookie_domains as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    const host = login.siteHost.toLowerCase();
    return jar.some((d) => {
      const domain = d.toLowerCase().replace(/^\./, "");
      return domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
    });
  } catch {
    return false;
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
  // The first starts and the rest wait their turn, so the line holds no more
  // than the queue does.
  approvedTogether: {
    max: QUEUE_MAX,
    line: lineOf,
    card(asked, lines) {
      const proposal = (asked.proposal ?? {}) as Record<string, unknown>;
      return {
        summary: `Use a browser to do these ${lines.length + 1} things?`,
        proposal: {
          ...proposal,
          // `cost` rides along unchanged: it is the workspace's balance, which
          // is one figure however many tasks are approved.
          thenInLine: lines.map((line, i) => `${i + 2}. ${line}`).join("\n"),
        },
      };
    },
    listed(proposal) {
      const list = (proposal as { thenInLine?: unknown } | null)?.thenInLine;
      if (typeof list !== "string") return [];
      return list.split("\n").flatMap((row) => {
        const match = LISTED.exec(row);
        return match ? [match[1]] : [];
      });
    },
  },
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
    const named = siteOf(input.site);
    if (named === INVALID_SITE) {
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
     * The profile is read first because it decides, below, whether a shared
     * login may be typed at all.
     */
    const profile = await profileFor(ctx.env, ctx.userId);

    /**
     * The model's `site`, or a host the task names that has a saved login —
     * with two exceptions that keep a login off a run its card did not show:
     *
     * - **A task approved as a line on another task's card** carries none.
     *   That card listed the sentence and nothing else (`lineOf` already keeps
     *   any task with a `site` out of a list), so a login found here from the
     *   task's text would be one nobody was shown.
     * - **A shared login is not typed into the person's own jar where it
     *   already has that site.** Their browser carries their own sign-in
     *   there; typing a colleague's shared account over it signs them out of
     *   their own and into somebody else's, in the session they keep using.
     *   Their own saved login still applies.
     */
    let site = named ?? (ctx.confirmedAsListed ? null : await siteFromTask(ctx, task));
    if (site && (await sharedLoginOverOwnJar(ctx, profile, site))) site = null;

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
    if (ctx.confirmed !== true) {
      const cost = await creditNote(ctx);
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
     * Ruling R44, beside R13's refusals below and for their reason: before
     * the provider is called, so before the meter. And before the browser row
     * is claimed, so a refusal leaves no claim to hand back. The person's own
     * browser and this run would carry one jar, and the one that stops last
     * writes it. One read, through the service role keyed to `ctx.userId`.
     */
    const ownBrowser = await heldTakeover(ctx.env, ctx.userId);
    if (ownBrowser === null) return { kind: "error", message: CANNOT_TELL };
    if (ownBrowser) return { kind: "error", message: OWN_BROWSER_OPEN };

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

    /**
     * The line (0080). A browser mid-run, or with tasks already waiting for
     * it, takes this one at the end of its line rather than refusing it: on
     * 2026-10-11 the refusal is what left an agent telling somebody three
     * tasks were running when one was. Waiting tasks count even when nothing
     * runs — a line held by a sign-in, or between one settle and the next
     * start — so the order is the order they were asked in.
     *
     * Nothing is charged here. The balance was asked above; the charge is
     * made when the task starts (`lib/browser/queue.ts`), and a task that
     * never starts costs nothing.
     */
    const waiting = await waitingInLine(ctx.env, session.value.id);
    if (waiting === null) return { kind: "error", message: CANNOT_TELL_LINE };
    if (session.value.runInFlight || waiting > 0) {
      if (waiting >= QUEUE_MAX) return { kind: "error", message: QUEUE_FULL };
      const queued = await queueBrowserTask(ctx.env, {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        task,
        site,
        browserSessionId: session.value.id,
      });
      if (!queued) {
        return {
          kind: "error",
          message:
            "the browser is busy and this task could not be put in line for it. Say so plainly " +
            "and offer to ask again once the current task is done; do not retry this turn.",
        };
      }
      return { kind: "ok", content: queuedFor(waiting + 1) };
    }

    /**
     * Ruling R19: a person with no jar gets one now, inside
     * `beginConversationRun` — after the refusals above, because a refusal
     * must cost nothing, and before the run, which carries it. The saved login
     * for `site` (Task 2.3) is looked up there too, after the refusals, so a
     * refused browse decrypts nothing. `lib/browser/start.ts` is shared with
     * the queue, so a task that waited its turn starts exactly as this one.
     */
    const begun = await beginConversationRun(ctx.env, {
      userId: ctx.userId,
      agentId: ctx.agentId,
      task,
      site,
      browser: session.value,
      profile,
      egressCountry: ctx.egressCountry ?? null,
      signal: ctx.signal,
    });
    const opening = session.value.providerSessionId === null;

    if (begun.kind === "error") {
      // A run that never started opened nothing, so the claim goes back —
      // otherwise every `browse` in the next minute is told to wait for it.
      // A follow-up's row names a live browser and is left alone.
      if (opening) await releaseBrowserSession(ctx.env, session.value.id);
      // 429 is the concurrency pool, which is account-wide and shared across
      // every tenant on this deployment — ten sessions at $0 lifetime spend.
      // Refused and said so. The line (0080) is this conversation's browser
      // doing one thing at a time; a full pool is every browser busy, and
      // waiting on it is a later problem with real numbers behind it.
      if (begun.status === 429) {
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
      if (wasBilled(begun.status) && begun.status !== 0) {
        await spend(ctx, [
          { kind: "browser_task", stage: "started", browserTaskId: null, costUsd: null },
        ]);
      }
      // Not retried, and never a second session: the busy one is this
      // conversation's browser, mid-run.
      if (begun.status === 409) return { kind: "error", message: STILL_RUNNING };
      // `begun.message` is a status line and never the provider's body:
      // `createRun` sends with `redactBody: true`, and a body that echoed this
      // request would echo a saved login's bindings into
      // `message_steps.result_excerpt`. Pinned in `browse.test.ts`.
      return { kind: "error", message: `could not start the browser task: ${begun.message}` };
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
      providerRunId: begun.value.run.id,
      browserSessionId: session.value.id,
      // Ruling R32: the saved login this run carried, so a login wall
      // afterwards is blamed on it — and on nothing the run was never given.
      ...(begun.value.credentialId ? { credentialId: begun.value.credentialId } : {}),
    });

    if (!recorded) {
      return {
        kind: "error",
        message:
          "the browser task started but could not be recorded, so its answer cannot be " +
          "delivered. Say that plainly and do not start another.",
      };
    }

    // The agent has the controls, a first run's session is now this
    // conversation's browser, and a profiled browser the run declined is
    // stopped (R41). See `finishRunStart`.
    await finishRunStart(ctx.env, session.value, begun.value, { signal: ctx.signal });

    // A hold, not the price: the provider's own figure is known only when the
    // run ends, and `settleTask` trues this up to it by `browserTaskId`.
    await spend(
      ctx,
      [{ kind: "browser_task", stage: "started", browserTaskId: recorded, costUsd: null }],
      { browserTaskId: recorded },
    );

    return {
      kind: "ok",
      content:
        "Started. A browser is doing this now and it usually takes a few minutes. The answer " +
        "will arrive as a new message in this conversation — tell the person that and finish " +
        "your reply. Do not call browse again for this.",
    };
  },
};
