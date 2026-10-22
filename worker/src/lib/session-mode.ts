import { isEndpointModel } from "./models";
/**
 * How a conversation's own settings and its agent's combine — the one rule,
 * written once, because four places in `routes/chat.ts` need it and a fifth
 * that forgot it would answer half a thread on the agent's dial and half on
 * the thread's.
 *
 * Since 0099 a session may carry its own model, reasoning effort, web search
 * and mode. Each is null until the person in the composer picks one, and null
 * means "whatever the agent says", which is what every session got before the
 * columns existed. A value overrides the agent's for every reply in that
 * session and for no other session.
 */

type SessionDial = {
  kind?: string | null;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  web_search?: boolean | null;
};

type AgentDial = {
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  web_search?: boolean | null;
};

/**
 * Brainstorm or not, in this order:
 *
 *  1. A session whose `kind` is brainstorm is one, whatever else says so. It
 *     has the idea board, and a board with an assistant that will not
 *     facilitate is a broken screen rather than a preference. This is also how
 *     a normal agent facilitates a brainstorm without its own setting changing.
 *  2. The session's own `mode`, when the person set one — including "normal"
 *     on a brainstorm agent, which is the point of having the choice.
 *  3. The agent's `mode`.
 */
export function effectiveMode(
  session: Pick<SessionDial, "kind" | "mode">,
  agent: Pick<AgentDial, "mode">,
): "normal" | "brainstorm" {
  if (session.kind === "brainstorm") return "brainstorm";
  const chosen = session.mode ?? agent.mode;
  return chosen === "brainstorm" ? "brainstorm" : "normal";
}

export type Tuning = {
  /**
   * The model id to ask for, before `resolveModel`. Null when neither the
   * session nor the agent names one, which `resolveModel` turns into the
   * deployment's default as it always has.
   */
  model: string | null;
  /** Unvalidated; `reasoningEffortFor` narrows it as it does the agent's. */
  reasoningEffort: string | null;
  webSearch: boolean;
};

/**
 * The model, effort and web search a reply in this session is made with.
 *
 * `served` is the list this deployment can answer on (`availableModels`).
 * When it is given, a session model outside it is passed over for the
 * agent's, the same fallback the per-reply override in `POST /chat/stream`
 * has always had: a thread somebody pinned to Claude before the Anthropic key
 * was removed keeps answering on the agent's model rather than on whatever
 * `resolveModel` falls back to, which is a model nobody in that thread chose.
 * The agent's own model is not held to the list here — `resolveModel` already
 * decides what happens to it, and this helper changes nothing it used to do.
 *
 * Effort and web search have no such check because there is nothing to
 * check: a model that does not reason ignores an effort, and a provider
 * without a search tool ignores the flag (`lib/completion.ts`).
 */
export function effectiveTuning(
  session: SessionDial,
  agent: AgentDial,
  served?: readonly string[],
): Tuning {
  const sessionModel =
    session.model && (!served || served.includes(session.model) || isEndpointModel(session.model))
      ? session.model
      : null;
  return {
    model: sessionModel ?? agent.model ?? null,
    reasoningEffort: session.reasoning_effort ?? agent.reasoning_effort ?? null,
    webSearch: session.web_search ?? agent.web_search ?? false,
  };
}
