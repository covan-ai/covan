import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { getActiveWorkspaceId } from "../workspace";
import { readWorkspaceKeys } from "./store";

/**
 * Which keys answer this caller's next operation.
 *
 * The allowance is spent per member on the operator's key, and what runs past
 * it is caught by the workspace's own key — per member, so one person
 * exhausting theirs does not shorten anybody else's month.
 *
 * `allowed` is passed in rather than checked here because every caller has just
 * called `entitlements.check` to decide whether to proceed at all. Checking
 * again would put a second round trip in front of every reply to answer a
 * question that was answered a line ago.
 */

export type KeySource = "house" | "workspace";

export type ProviderKeys = {
  openai: string;
  anthropic?: string;
  source: KeySource;
};

/** The slice of the environment that naming a key changes. */
export type ProviderEnv = { OPENAI_API_KEY: string; ANTHROPIC_API_KEY?: string };

/**
 * The operator's own keys, as a `ProviderKeys`.
 *
 * Exported because "the operator is paying" is a state some callers are in
 * without ever having resolved anything — a request inside its allowance never
 * calls `keysForUser` at all — and they still have to be able to answer
 * `billsTheOperator` below with something rather than with `undefined`.
 */
export function houseKeys(env: ProviderEnv): ProviderKeys {
  return { openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, source: "house" };
}

/**
 * Whether the tokens spent on these keys land on the operator's bill.
 *
 * The one place this question is phrased, and phrased *positively* on purpose.
 * Every site that writes to the entitlements counter was originally asking the
 * inverse — `keys.source !== "workspace"` — which is correct only for as long
 * as `KeySource` has exactly the two members it has today. Add a third (a
 * reseller's key, a per-agent key, anything) and every one of those inverses
 * silently starts billing the operator for tokens somebody else paid for; a
 * mistake that costs money and announces itself nowhere.
 *
 * Asked this way round, a new `KeySource` fails closed instead: it is not
 * `"house"`, so nothing is written to the operator's counter until somebody
 * decides it should be. Under-counting is a number that can be reconstructed
 * from `messages` and `routine_runs`; over-counting is a bill.
 */
export function billsTheOperator(keys: ProviderKeys): boolean {
  return keys.source === "house";
}

export async function keysForUser(
  env: RoutineEnv,
  db: SupabaseClient,
  userId: string,
  allowed: boolean,
): Promise<ProviderKeys> {
  if (allowed) return houseKeys(env);

  try {
    const workspaceId = await getActiveWorkspaceId(db, userId);
    if (!workspaceId) return houseKeys(env);

    const stored = await readWorkspaceKeys(env, workspaceId);

    // OpenAI is the key that answers everything — embeddings, transcription and
    // the default model all need it. An Anthropic key on its own cannot carry a
    // workspace past its allowance, so a workspace that set only that one stays
    // on the operator's keys and keeps seeing the 402.
    if (!stored.openai) return houseKeys(env);

    return {
      openai: stored.openai,
      anthropic: stored.anthropic ?? undefined,
      source: "workspace",
    };
  } catch (err) {
    // Same rule as `guardQuota`'s read failure: a failure of ours falls back to
    // the operator's key rather than refusing a reply somebody is owed.
    console.error("could not resolve workspace keys (falling back to the operator's)", err);
    return houseKeys(env);
  }
}

/**
 * The resolved keys as an environment.
 *
 * Every path that spends already takes an env-shaped object — `createOpenAI(env)`,
 * `CompletionEnv`, `{ OPENAI_API_KEY }` for embeddings — so handing them a
 * replacement env is what lets eleven call sites change by one line each and
 * none of them learn what a workspace key is.
 *
 * A copy, never a mutation: `c.env` is shared across every request the isolate
 * handles, and writing to it would leak one workspace's key into the next
 * request.
 */
export function withProviderKeys<E extends ProviderEnv>(env: E, keys: ProviderKeys): E {
  return { ...env, OPENAI_API_KEY: keys.openai, ANTHROPIC_API_KEY: keys.anthropic };
}
