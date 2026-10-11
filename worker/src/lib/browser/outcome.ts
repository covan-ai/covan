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
 * The whole request a conversation's run is created with, for `browse` and for
 * the hand-back alike.
 *
 * One builder rather than two literals, because the hand-back is the same run
 * with a different sentence: if the two drifted, the follow-up after a person
 * signed in would be the one run that came back without the outcome shape, or
 * without the cost ceiling the free retry is bounded by.
 */
export function conversationRun(
  env: { BROWSER_USE_MODEL?: string },
  input: {
    task: string;
    /** The provider session to continue; absent for the run that opens it. */
    sessionId?: string | null;
    profile?: { providerProfileId: string; proxyCountryCode: string | null } | null;
  },
): CreateRunInput {
  return {
    // The preamble and the schema are the same constant twice over; see the
    // file header and ruling R8.
    task: runTask(input.task),
    outputSchema: OUTCOME_SCHEMA,
    // A follow-up continues the browser this conversation already has. A
    // first run names no session and the provider opens one.
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // Omitted entirely when there is no jar, so a public-web run sends no
    // `browserSettings` at all. The country is sent only when the jar pins
    // one, as `createBrowser` and `retryBrowserTask` send it: an explicit
    // `null` is the provider's "no proxy" (`v4.ts`), while an absent key is its
    // default egress. A jar provisioned for a run pins none (ruling R19), and
    // a person's run must not lose the proxy it had before they had a jar.
    ...(input.profile
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
    // The ceiling `BROWSER_TASK_TOKENS` was priced against, enforced by the
    // provider rather than hoped for. The person never pays browser-use; this
    // is what keeps the operator's side of that bounded — the hand-back's
    // free retry included.
    maxCostUsd: RUN_COST_CAP_USD,
  };
}
