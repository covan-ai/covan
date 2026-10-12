import type { CredentialBinding } from "./credentials";
import { DEFAULT_MODEL, RUN_COST_CAP_USD, type CreateRunInput } from "./v4";

/**
 * What a `browse` run is asked to end with, in one place.
 *
 * v2 ended a task with prose and an `isSuccess` flag, and "the agent hit a
 * login wall" had to be guessed from `isSuccess: false` — which also meant a
 * dead link, a captcha, or a page that said no. The browser panel needs the
 * difference, because a login wall is the one failure a person can fix with
 * their own hands while the browser is still there: so the run is asked for a
 * structured answer, and `login_required` with the site's host is the case
 * the panel acts on.
 *
 * **Asked for twice, from this one constant, on purpose (ruling R8).** The
 * provider's OpenAPI accepts `outputSchema` on a run; its documentation says
 * v4 does not. Until the operator's end-to-end run settles which is true,
 * `browse` sends the schema AND puts the same schema, verbatim, in the task's
 * preamble — so whichever channel the provider honours, the answer comes back
 * in this shape, and the two requests cannot drift apart because neither is
 * written twice. Reading the answer is `deliver`'s business, not this file's.
 */

/** `done`, or one of the two reasons a run stopped short. */
export const OUTCOME_STATUSES = ["done", "login_required", "blocked"] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** `{ status, host?, answer? }`, as JSON Schema. Sent as the run's `outputSchema`. */
export const OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: [...OUTCOME_STATUSES] },
    /** The site that wants a sign-in, for `login_required`. */
    host: { type: "string" },
    /** What the agent found or did, in its own words. */
    answer: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

/**
 * A bare lowercase host — the shape `browser_tasks.signin_host` is checked to
 * (0078), and the one `allowedDomains` wants. The run's `host` is a model's
 * words: it may be a URL, carry a port, or come back in capitals, and a screen
 * will render this. So the plain mistakes are repaired — whitespace trimmed,
 * case folded, a URL reduced to its hostname, a port stripped — and whatever
 * is still not the exact shape after that is dropped: a panel with no host
 * still says "sign in"; a panel with a wrong host sends the person to the
 * wrong site. The repairs only ever narrow a string to the host it already
 * names; nothing is guessed (a bare `me@site` or `site/login` stays null).
 *
 * Here rather than in `settle.ts`, which stores it, because the message
 * `deliver.ts` writes names the same site: the panel and the conversation
 * should not disagree about which one wants a sign-in.
 */
export function bareHost(value: string | null): string | null {
  if (value === null) return null;
  let host = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/:\d+$/, "");
  return host && !/[/:@\s]/.test(host) ? host : null;
}

/**
 * Words the model never writes, put in front of the one sentence it did.
 *
 * The first sentence is the plan's, verbatim. The second asks for the final
 * answer in the schema's shape — the schema itself, serialised, rather than a
 * paraphrase of it, which is what keeps it from drifting.
 */
export const RUN_PREAMBLE =
  "If a page requires signing in and you have no credential for it, stop and report " +
  "`login_required` with the site's host. " +
  "End with your final answer as exactly one JSON object matching this JSON Schema — " +
  "`done` when the task is finished, `blocked` when something else stopped you, and what " +
  `you found or did in \`answer\`: ${JSON.stringify(OUTCOME_SCHEMA)}`;

/** The task text a run is created with: the preamble, then the person's sentence untouched. */
export function runTask(task: string): string {
  return `${RUN_PREAMBLE}\n\nTask: ${task}`;
}

/**
 * The one sentence that tells the agent a saved login exists, in the plan's
 * words (Task 2.3). It names the two aliases and never a value: browser-use
 * types the value into a field on the binding's `allowedDomains` when the agent
 * asks for the alias, and the agent — and every transcript of what it was told
 * — sees the alias only.
 *
 * The aliases are the ones the bindings were built under (`credentialAliases`,
 * carried on the login), not re-derived here: an alias the sentence spells
 * differently from the binding is one the agent asks for and is never given.
 */
export function savedLoginSentence(login: {
  siteHost: string;
  aliases: { username: string; password: string };
}): string {
  return (
    `A saved login for ${login.siteHost} is available as \`${login.aliases.username}\` and ` +
    `\`${login.aliases.password}\`; use them when the site asks.`
  );
}

/**
 * The jar a run may name, given the jar the conversation's browser was opened
 * with.
 *
 * The provider's contract on `profileId`: a different profile on a session is
 * a 400 (and a charged one), and an explicit value that mismatches the live
 * browser's — null against a profiled browser included — declines reuse and
 * provisions a fresh browser, which has lost the sign-in the person made in
 * the one they were using. So a follow-up or a hand-back names the jar only
 * when it is the one that browser was opened with; otherwise it names none and
 * the provider reuses the browser as it is. A run that opens the browser
 * (`opening`) has nothing to mismatch and carries the jar it has.
 */
export function jarForSession<T extends { id: string }>(
  jar: T | null,
  session: { opening: boolean; openedWith: string | null },
): T | null {
  if (!jar) return null;
  return session.opening || jar.id === session.openedWith ? jar : null;
}

/**
 * The jar a run carries once the login it carries is known — `jarForSession`,
 * except for a shared login (ruling R38, the operator's).
 *
 * **A shared login is never written into a person's jar.** A browser opened
 * with somebody's profile saves into that profile what happens in it, the
 * sign-in a binding performs included. For the person's own login that is
 * their jar keeping their account, as it always has. For a login saved "for
 * everyone using this agent" it would put the shared account into the cookies
 * of whoever ran the task — and then Forget, or the saver leaving the
 * workspace (R29), would not stop the agent acting as that account: the next
 * run would simply arrive signed in. So a run carrying a shared login runs in
 * a browser with no profile:
 *
 * Every such run says so in its body, **explicitly** (ruling R40): `browserSettings
 * .profileId: null`, which the provider reads as "no profile" — against a
 * browser with none it is a match and the browser is reused, against a
 * profiled one it declines reuse and provisions a fresh one in the same
 * session: *"an explicit value mismatching the live browser's profile (incl.
 * null vs a profiled browser) declines reuse and provisions fresh"*. Leaving
 * the key out would instead mean "no opinion", and a browser the row does not
 * record as profiled (a claim that raced a provisioning, say) would carry the
 * shared login into the person's jar. So, for the three kinds of run:
 *
 * - **the run that opens the browser** opens it without a profile;
 * - **a follow-up into a browser opened with the person's jar** is `detach`:
 *   the provider answers with a fresh, profile-less browser, and the caller
 *   takes the jar off the row, so later follow-ups (R23) do not send it into
 *   the browser that has none;
 * - **a follow-up into a browser opened without one** reuses it as it is.
 *
 * `withoutProfile` is what the body says; `detach` only decides the
 * bookkeeping around a browser the provider declined.
 *
 * Unverified against the real provider (an end-to-end item): the contract is
 * the OpenAPI's sentence above.
 */
export function jarForRun<T extends { id: string }>(
  jar: T | null,
  session: { opening: boolean; openedWith: string | null },
  login: Pick<CredentialBinding, "scope" | "bindings"> | null,
): { profile: T | null; withoutProfile: boolean; detach: boolean } {
  if (login?.scope === "agent" && login.bindings.length > 0) {
    return {
      profile: null,
      withoutProfile: true,
      detach: !session.opening && session.openedWith !== null,
    };
  }
  return { profile: jarForSession(jar, session), withoutProfile: false, detach: false };
}

/**
 * The whole request a conversation's run is created with, for `browse` and for
 * the hand-back alike.
 *
 * One builder rather than two literals, because the hand-back is the same run
 * with a different sentence: if the two drifted, the follow-up after a person
 * signed in would be the one run that came back without the outcome shape, or
 * without the cost ceiling the free retry is bounded by.
 *
 * `login` is a saved login exactly as `credentialsFor` answers it (Task 2.3),
 * so `browse` and — from 2.4 — the hand-back pass that answer straight in, and
 * the bindings and the sentence naming them cannot be sent one without the
 * other. Bindings are run-scoped at the provider: a follow-up that needs the
 * login must carry it again, which is why it is an input here and not
 * something remembered.
 */
export function conversationRun(
  env: { BROWSER_USE_MODEL?: string },
  input: {
    task: string;
    /** The provider session to continue; absent for the run that opens it. */
    sessionId?: string | null;
    profile?: { providerProfileId: string; proxyCountryCode: string | null } | null;
    /**
     * Ask for a browser without a profile (`jarForRun`'s `withoutProfile`,
     * rulings R38 and R40): `profileId: null`, explicitly, in place of any jar.
     */
    withoutProfile?: boolean;
    login?: Pick<CredentialBinding, "siteHost" | "aliases" | "bindings"> | null;
  },
): CreateRunInput {
  const login = input.login?.bindings.length ? input.login : null;
  return {
    // The preamble and the schema are the same constant twice over; see the
    // file header and ruling R8. A saved login's sentence goes between the
    // preamble and the person's sentence, which stays last and untouched.
    task: login
      ? `${RUN_PREAMBLE}\n\n${savedLoginSentence(login)}\n\nTask: ${input.task}`
      : runTask(input.task),
    outputSchema: OUTCOME_SCHEMA,
    // Exactly the bindings `credentialsFor` built, with the `allowedDomains`
    // it took from the saved row (Review focus 4) — nothing here widens them.
    // Omitted when there is no login, so a run without one is the request it
    // was before saved logins existed.
    ...(login ? { secretBindings: login.bindings } : {}),
    // A follow-up continues the browser this conversation already has. A
    // first run names no session and the provider opens one.
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // Omitted entirely when there is no jar, so a public-web run sends no
    // `browserSettings` at all. The country is sent only when the jar pins
    // one, as `createBrowser` and `retryBrowserTask` send it: an explicit
    // `null` is the provider's "no proxy" (`v4.ts`), while an absent key is its
    // default egress. A jar provisioned for a run pins none (ruling R19), and
    // a person's run must not lose the proxy it had before they had a jar.
    // A run carrying a shared login (R38, R40) sends the one explicit
    // `profileId: null` and no country, so a fresh browser inherits the
    // session's egress.
    ...(input.withoutProfile
      ? { profileId: null }
      : input.profile
        ? {
            profileId: input.profile.providerProfileId,
            ...(input.profile.proxyCountryCode === null
              ? {}
              : { proxyCountryCode: input.profile.proxyCountryCode }),
          }
        : {}),
    // `||`, as `v4BaseOf`: `docker-compose.yml` hands an unset variable over
    // as an empty string, and an empty model is a 422.
    model: env.BROWSER_USE_MODEL || DEFAULT_MODEL,
    // A ceiling on what one run may cost, enforced by the provider rather than
    // hoped for. The person never pays browser-use; this
    // is what keeps the operator's side of that bounded — the hand-back's
    // free retry included.
    maxCostUsd: RUN_COST_CAP_USD,
  };
}
