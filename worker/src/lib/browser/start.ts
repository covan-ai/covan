import type { RoutineEnv } from "../../types";
import type { BrowserResult } from "./client";
import { credentialsFor, type CredentialBinding } from "./credentials";
import { conversationRun, jarForRun } from "./outcome";
import { stopDeclinedBrowser } from "./profiles";
import { recordRunStart } from "./sessions";
import { profileFor, runProfile, type TakeoverProfile } from "./takeover";
import { createRun, type CreatedRun } from "./v4";

/**
 * Starting a run in a conversation's browser, shared by the two things that
 * do it: `browse`, when the person has just approved a task and the browser
 * is free, and the queue (`queue.ts`), when a task that waited its turn comes
 * up. One body, so the jar rules (R19, R23, R38, R41), the saved login (Task
 * 2.3) and the order of the writes cannot drift between them.
 *
 * Two halves, because the caller's own write goes between them: `browse`
 * records the task row and the queue moves its row to `queued`, and that
 * write has to land BEFORE `recordRunStart` and the charge — a run nothing in
 * this database names is money spent on an answer nobody can deliver.
 */

/** The conversation's browser, as `ensureBrowserSession` or the queue read it. */
export type RunBrowser = {
  id: string;
  providerSessionId: string | null;
  profileId: string | null;
  providerBrowserId?: string | null;
};

/** A run the provider accepted, and what the second half needs to know about it. */
export type BegunRun = {
  run: CreatedRun;
  /** The saved login the run carries as bindings, or null (ruling R32). */
  credentialId: string | null;
  opening: boolean;
  detach: boolean;
  withoutProfile: boolean;
  sentProfileId: string | null;
};

/**
 * The saved login a run on `site` carries, or null.
 *
 * A read that fails is a run without the login, not a run that does not
 * start: it meets the login wall and says so, which the person can fix in the
 * panel. Logged as a fixed sentence and nothing else — the error names a table
 * and a code today, and this line must stay safe whatever it names tomorrow.
 */
export async function loginFor(
  env: RoutineEnv,
  who: { agentId: string; userId: string },
  site: string,
): Promise<CredentialBinding | null> {
  try {
    return await credentialsFor(env, { agentId: who.agentId, userId: who.userId, host: site });
  } catch {
    console.warn("could not read the saved logins for a browser task; running without one");
    return null;
  }
}

/**
 * Ask the provider for the run. Nothing is written here; on an error the
 * caller decides what it costs and what to say.
 *
 * `profile` is the person's jar if the caller already read it (`browse` reads
 * it for the card), or `undefined` to read it here. Either way a person with
 * no jar gets one now (ruling R19), so what they sign in to in the panel has
 * a profile to be saved into.
 */
export async function beginConversationRun(
  env: RoutineEnv,
  input: {
    userId: string;
    agentId: string;
    task: string;
    site: string | null;
    browser: RunBrowser;
    profile?: TakeoverProfile | null;
    signal?: AbortSignal;
  },
): Promise<BrowserResult<BegunRun>> {
  const known = input.profile === undefined ? await profileFor(env, input.userId) : input.profile;
  const jar = known ?? (await runProfile(env, input.userId));

  const continuing = input.browser.providerSessionId;
  const opening = continuing === null;
  // After every refusal, so a refused task decrypts nothing; and on every run
  // that names the site — the provider's bindings are run-scoped.
  const login = input.site ? await loginFor(env, input, input.site) : null;
  // A follow-up names the jar only when its browser was opened with it; a run
  // carrying a shared login carries no jar at all (R38). See `jarForRun`.
  const {
    profile: sent,
    withoutProfile,
    detach,
  } = jarForRun(jar, { opening, openedWith: input.browser.profileId }, login);

  const created = await createRun(
    env,
    conversationRun(env, {
      task: input.task,
      sessionId: continuing,
      profile: sent,
      withoutProfile,
      login,
    }),
    { signal: input.signal },
  );
  if (created.kind === "error") return created;
  return {
    kind: "ok",
    value: {
      run: created.value,
      // The same condition `conversationRun` puts the bindings in the body on.
      credentialId: login?.bindings.length ? login.id : null,
      opening,
      detach,
      withoutProfile,
      sentProfileId: sent?.id ?? null,
    },
  };
}

/**
 * The browser's side of a run that has started and been recorded: the agent
 * has the controls, a first run's session is now the conversation's browser,
 * and a profiled browser the run declined is stopped (R41). Logged rather
 * than failed throughout: the run is real and its answer will still arrive.
 */
export async function finishRunStart(
  env: RoutineEnv,
  browser: RunBrowser,
  begun: BegunRun,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await recordRunStart(env, {
    browserSessionId: browser.id,
    ...(begun.opening ? { providerSessionId: begun.run.sessionId } : {}),
    // Only by the run that opens the browser: a follow-up's browser keeps the
    // jar it was opened with. A shared login's run takes the jar off the row
    // instead (R38), and a detached follow-up's browser is a fresh one.
    ...(begun.detach ? { providerBrowserId: null } : {}),
    ...(begun.withoutProfile
      ? { profileId: null }
      : begun.sentProfileId && begun.opening
        ? { profileId: begun.sentProfileId }
        : {}),
  });
  // After the write above, which already made the row forget the declined
  // browser, so the panel and the settle converge on the new one first.
  if (begun.detach) {
    await stopDeclinedBrowser(env, browser.providerBrowserId ?? null, { signal: opts.signal });
  }
}
