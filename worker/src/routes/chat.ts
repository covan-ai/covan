import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";
import { serviceClient } from "../lib/supabase";
import { resolveModel, modelSpec, titleModelFor, availableModels } from "../lib/models";
import { type CompletionMessage, type CompletionUsage } from "../lib/completion";
import {
  parseArguments,
  runWithTimeout,
  type AgentStep,
  type PassUsage,
} from "../lib/harness/loop";
import { capabilitiesFor } from "../lib/harness/available";
import { toolByName } from "../lib/harness/registry";
import { cap, MAX_TOOL_OUTPUT_CHARS, TOOL_TIMEOUT_MS } from "../lib/harness/budget";
import { loadPausedTurn, resolvePausedTurn, savePausedTurn, writeSteps } from "../lib/harness/turn";
import { retrieveForAgent } from "../lib/retrieval";
import {
  selectHistory,
  MSG_HISTORY_LIMIT,
  HISTORY_CHAR_BUDGET,
  PER_MESSAGE_CHAR_CAP,
} from "../lib/history";
import { buildSystemPrefix, temperatureFor, maxTokensFor, reasoningEffortFor } from "../lib/prompt";
import { effectiveMode } from "../lib/session-mode";
import { generateSessionTitle } from "../lib/session-title";
import { generateFollowUps } from "../lib/follow-ups";
import { deferred } from "../lib/defer";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";
import { runtimeLimitFlag } from "../lib/runtime-limit";
import {
  CUT_SHORT,
  buildToolContext,
  explainTurnFailure,
  isAbort,
  runChatTurn,
  salvagePartial,
  spentUsage,
  turnSpend,
} from "./chat-turn";

const chat = new Hono<AppEnv>();

const streamChatSchema = z.object({
  sessionId: z.string().min(1),
  /**
   * Finish the reply already at the end of this conversation, rather than
   * answering a new question.
   *
   * A chat reply is capped at `maxTokensFor("normal")` — 4096 tokens, which is
   * a deliberate cost decision and not an accident. The consequence is that a
   * long answer stops mid-thought and otherwise looks finished, which is the
   * worst way for a reply to be wrong: nothing on screen says the end is
   * missing. The stream says `truncated` when it happens; this is what the
   * button that appears in response to it calls.
   */
  continue: z.boolean().optional(),
  /**
   * Answer the last question again, keeping the answer that is already there.
   *
   * Regenerating used to delete: the reply went, the question was re-asked,
   * and there was no way back — so what the button actually asked was "are you
   * sure the next answer will be better than this one", which nobody can know
   * before seeing it. Migration 0050 gives an answer versions; this writes one.
   *
   * The last answer only. Regenerating one in the middle of a conversation
   * would leave every turn after it replying to something that is no longer
   * there, and making those turns a branch is a conversation tree rather than
   * a version list — a different feature, and a much larger one.
   */
  regenerate: z.boolean().optional(),
  /**
   * Answer on a different model than the agent's, for this reply only.
   *
   * The agent's own model is a setting somebody chose; this is "try that
   * again on something stronger" and has no business overwriting it. Checked
   * against what this deployment can actually serve — an id that is not
   * offered here falls through to `resolveModel`, which is the same thing it
   * does for an agent carrying a model whose key has been rotated out.
   */
  model: z.string().optional(),
});

/**
 * What the model is told when it is asked to carry on.
 *
 * Sent as a *user* turn with the cut-off reply as the assistant turn before
 * it, which is not the obvious shape — the obvious shape is to end the message
 * list with the partial answer and let the model run on from it. That is a
 * prefill, and it returns a 400 on every Claude model from 4.6 onward. Asking
 * in words works on both providers and costs one short turn.
 */
const CONTINUE_INSTRUCTION =
  "Your previous reply was cut off at its length limit. Carry on from exactly " +
  "where it stops — continue the same sentence if it was mid-sentence. Do not " +
  "repeat anything you already wrote, do not start over, and do not introduce " +
  "the continuation.";

// POST /chat/stream
chat.post("/chat/stream", async (c) => {
  const db = c.get("db");

  // Before anything is loaded, embedded or generated. Once the stream is open
  // the response is a 200 with an SSE body, and there is no honest way to turn
  // that back into a 402.
  const denied = await guardQuota(c);
  if (denied) return denied;

  // Whose key answers. `guardQuota` sets this only when the caller is past
  // their allowance and the workspace is carrying it from here; undefined is
  // the normal case and means the operator's.
  const env = c.get("providerEnv") ?? c.env;

  const parsed = streamChatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { sessionId, continue: continuing = false, regenerate = false } = parsed.data;

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return c.json({ error: "failed to load session" }, 500);
  }
  if (!session) {
    return c.json({ error: "not found" }, 404);
  }

  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("*")
    .eq("id", session.agent_id)
    .maybeSingle();

  if (agentError) {
    return c.json({ error: "failed to load agent" }, 500);
  }
  if (!agent) {
    return c.json({ error: "not found" }, 404);
  }

  const { data: recentDesc, error: messagesError } = await db
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(MSG_HISTORY_LIMIT);

  if (messagesError) {
    return c.json({ error: "failed to load messages" }, 500);
  }

  const rows = (recentDesc ?? []).slice().reverse();
  const lastMessage = rows[rows.length - 1];
  // Which end of the conversation this turn is working from. Answering needs a
  // question to answer; continuing needs an answer to continue.
  if (continuing || regenerate) {
    if (!lastMessage || lastMessage.role !== "assistant") {
      return c.json({ error: continuing ? "nothing to continue" : "nothing to regenerate" }, 400);
    }
  } else if (!lastMessage || lastMessage.role !== "user") {
    return c.json({ error: "no user message to respond to" }, 400);
  }

  // What the retrieval is *for*, which on a continuation is not the last
  // message — that is the half-written answer. It is the question that answer
  // was already halfway through, so the second half is grounded in the same
  // documents as the first.
  const question =
    continuing || regenerate
      ? ([...rows].reverse().find((m: { role: string }) => m.role === "user")?.content ?? "")
      : lastMessage.content;

  // What the model is shown. A regeneration is being asked the same question
  // over again, so the answer it is replacing must not be in front of it —
  // left there, the model reads its own previous reply and writes a variation
  // on it rather than a second attempt at the question.
  const turns = regenerate ? rows.slice(0, -1) : rows;

  const mode: "normal" | "brainstorm" = effectiveMode(session, agent);

  // What the agent knows, assembled for this question: the manifest of document
  // names, the grounding block, what grounded it, and which path found it. This
  // was written out here until a Slack thread needed to ask an agent the same
  // question — see `lib/retrieval.ts` for why one copy rather than two.
  const { docNames, ragBlock, sources, grounding, embeddingTokens } = await retrieveForAgent(
    db,
    env,
    session.agent_id,
    question,
    turns.map((m: { role: string; content: string }) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    })),
  );

  // Manifest: a stable, cacheable line telling the agent which documents it has,
  // appended to the persona system prefix. This is the "file referencing" that
  // stops the agent from denying it can access uploaded files.
  // What this agent can reach, and the paragraph that tells it so. Read
  // before the prefix is built because the manifest rides inside it: it is
  // stable turn over turn, so it caches with the persona instead of being
  // bought again on every question — the same reasoning as the document
  // manifest it sits beside.
  const { tools, manifest } = await capabilitiesFor({
    db,
    env,
    workspaceId: session.workspace_id as string,
    userId: c.get("user").id,
  });

  const systemPrefix =
    buildSystemPrefix({
      persona: agent.persona,
      mode,
      docNames,
      webSearchEnabled: agent.web_search ?? false,
    }) + (manifest ? `\n\n${manifest}` : "");

  // Budget the history down to the most recent turns that fit, so long chats
  // (and giant pasted messages) don't re-inflate the input on every turn.
  const history = selectHistory(
    turns.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { maxChars: HISTORY_CHAR_BUDGET, perMessageCap: PER_MESSAGE_CHAR_CAP },
  );

  // Assemble so the stable prefix (persona + prior turns) is byte-identical
  // turn-over-turn and cacheable; the volatile RAG block rides just before the
  // latest user turn, where it grounds the answer without breaking that prefix.
  const priorTurns = history.slice(0, -1);
  const latestTurn = history[history.length - 1];
  const messages: CompletionMessage[] = [
    { role: "system", content: systemPrefix },
    ...priorTurns,
    ...(ragBlock ? [{ role: "system" as const, content: ragBlock }] : []),
    ...(latestTurn ? [latestTurn] : []),
    // On a continuation `latestTurn` is the cut-off answer, and this is the
    // turn that asks for the rest of it. See `CONTINUE_INSTRUCTION` for why it
    // is a user turn rather than the obvious thing.
    ...(continuing ? [{ role: "user" as const, content: CONTINUE_INSTRUCTION }] : []),
  ];

  // The agent's model, unless this one reply asked for another.
  //
  // Checked against what this deployment can actually serve rather than taken
  // on trust: an id nobody offers falls back to the agent's own, which is the
  // same thing `resolveModel` already does for an agent carrying a model whose
  // key has been rotated out. The override is per-reply on purpose — the
  // agent's model is a setting somebody chose, and "try that again on
  // something stronger" has no business overwriting it.
  const requested = parsed.data.model;
  const picked =
    requested && (availableModels(env) as string[]).includes(requested) ? requested : agent.model;
  const model = resolveModel(picked, env);

  // `availableModels` (`lib/models.ts`) is computed from the deployment's own
  // environment and carried to the frontend once, by `/me` — it has no idea
  // which key is about to answer *this* particular reply. So the picker can
  // still be showing Claude to someone who is, this turn, running on a
  // workspace key that only covers OpenAI. `resolveModel` above already does
  // the right thing about it: a Claude pick with no key for it quietly falls
  // through to the default rather than failing the reply. That fallback is
  // correct and already shipped — nothing here changes it. What was missing
  // is that it happened without a word, and the reply that comes back is from
  // a different model than the one on screen.
  //
  // Making `/me` aware of which key answers for which caller would be the
  // real fix, and is deliberately not this: it is a response every screen
  // reads, and reworking it would be a lot of surface to close an edge that
  // only exists for a workspace that set one key and not the other. Saying so
  // once, here, is the whole scope.
  const claudeDroppedForWorkspaceKey =
    Boolean(c.get("providerEnv")) &&
    modelSpec(picked)?.provider === "anthropic" &&
    model !== picked;

  const signal = c.req.raw.signal;
  const service = serviceClient(c.env);

  // Name the conversation from the message that opened it, the way every other
  // chat product does — an untitled sidebar of "New chat, New chat, New chat"
  // is a list you cannot navigate.
  //
  // Started here, before the reply, so it runs alongside the streaming
  // completion instead of after it: the reply takes seconds and this takes
  // under one, so in practice the turn never waits. Deliberately *not*
  // deferred past the response — the frontend refetches the session list when
  // the stream closes, and a title written after that lands in a sidebar
  // nobody is going to reload.
  //
  // Only for a session with no title. A named session is one the user or an
  // earlier turn already settled, and re-titling it every turn would both cost
  // money and move a label out from under someone reading it.
  //
  // On the cheapest model of the same provider, not on the agent's — see
  // `titleModelFor`. A title is five words and the agent's model has nothing to
  // add to them.
  const titling = session.title
    ? null
    : generateSessionTitle(env, titleModelFor(model, env), question);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Computed once, above, from `agent.model` and the env this reply is
      // actually using — not re-derived per delta — so this can only ever
      // fire once per reply.
      if (claudeDroppedForWorkspaceKey) {
        send({
          type: "notice",
          text: `Your workspace key has no Anthropic key, so this reply came from ${model}.`,
        });
      }

      /**
       * What the turn has produced so far, filled as it runs.
       *
       * The words on screen, every step that settled, and every pass's usage —
       * all three held where the `catch` can still reach them, because
       * `runAgentTurn` returns none of them when it throws. See `TurnSpend`.
       */
      const spend = turnSpend();
      // Token usage arrives once, after the last delta, whichever provider
      // answered — `lib/completion.ts` normalises the two shapes into one
      // event. Captured for the usage dashboard.
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      // How much of `promptTokens` the provider served from its prompt cache —
      // a subset of that count, not an addition. This is the only evidence that
      // the cacheable-prefix assembly above is actually working; without it a
      // change that silently breaks the cache costs real money and shows up
      // nowhere.
      let cachedTokens: number | null = null;
      // And how much of it was bought at Anthropic's 1.25x storage premium.
      // Disjoint from `cachedTokens`: a token is read from the cache or
      // written into it, never both. Always null on OpenAI, whose cache fills
      // itself for nothing. Without this the two halves of a caching change
      // cannot be weighed against each other — more reads is only a saving if
      // the writes that bought them cost less than the reads saved.
      let cacheWriteTokens: number | null = null;
      // How much of `completionTokens` went on deliberation rather than on the
      // answer. A subset of it, so pricing is unaffected and this is purely
      // diagnostic — but output is 86% of what a GPT-5 tool turn costs, and
      // without this the bill's largest line cannot be read. Null on
      // Anthropic, which reports no separate count.
      let reasoningTokens: number | null = null;
      // What each model call in the turn cost, in order. A tool turn is
      // several requests and the totals above are their sum, which hides the
      // shape: eight even passes and one enormous last pass add up the same.
      let passUsage: PassUsage[] = [];
      let persisted = false;
      let spendRecorded = false;
      // What the turn did, and whether it stopped to ask. Both are filled by
      // `runAgentTurn` below and read after the reply is persisted, because a
      // step belongs to a message and the message does not exist until then.
      let steps: AgentStep[] = [];
      /**
       * Raised if anything in this turn discovers the invocation is out of
       * platform budget. Read only by the `catch` below, to replace a message
       * that explains nothing with one that does. See `lib/runtime-limit.ts`.
       */
      const runtimeLimit = runtimeLimitFlag();
      let paused: Awaited<ReturnType<typeof runChatTurn>>["paused"] | null = null;

      // Collect the title started above and write it, returning what it cost so
      // the caller can charge it with the rest of the turn. Written with the
      // service client for the same reason `updated_at` is: the bump has to
      // work whoever drove the reply, owner or not.
      //
      // `.is("title", null)` is the whole safety of it. Between the call
      // starting and this landing, the user may have renamed the session
      // themselves — the filter means the generated name loses that race
      // rather than silently overwriting a name somebody chose.
      const settleTitle = async (): Promise<number> => {
        if (!titling) return 0;
        const { title, tokens } = await titling;
        if (title) {
          const { error: titleError } = await service
            .from("chat_sessions")
            .update({ title })
            .eq("id", sessionId)
            .is("title", null);
          if (titleError) console.error("failed to write session title", titleError);
        }
        return tokens;
      };

      // One counter write per turn, on every way this stream can end — a reply
      // that was cut off still cost what it cost. Guarded because several of
      // those endings overlap (an abort mid-loop also lands in the catch).
      //
      // The title is settled from in here rather than from each ending, so the
      // tokens it spent are in the same write and no ending can forget it. That
      // includes an abort: the titling call had already been made and paid for
      // by the time the user hit stop.
      const recordSpend = async () => {
        if (spendRecorded) return;
        spendRecorded = true;
        const titleTokens = await settleTitle();
        await recordQuota(
          c,
          embeddingCost(embeddingTokens) +
            (promptTokens ?? 0) +
            (completionTokens ?? 0) +
            titleTokens,
        );
      };

      // Assistant rows are server-authoritative — always written with the
      // service-role client (RLS forbids client-authored assistant rows).
      const persistAssistant = async (
        text: string,
        opts: {
          promptTokens: number | null;
          completionTokens: number | null;
          cachedTokens: number | null;
          cacheWriteTokens: number | null;
          reasoningTokens: number | null;
          passUsage: PassUsage[];
        },
      ) => {
        if (persisted || text.trim().length === 0) return null;
        persisted = true;

        // A continuation is written *into* the reply it finishes, not beside
        // it. Two assistant messages where the model wrote one answer is not a
        // transcript — and the next turn would then send the two halves as two
        // separate turns, which is not what the model said.
        //
        // Joined with nothing between them: the instruction asks it to carry
        // on from exactly where the text stops, which is often mid-sentence,
        // and a space inserted there would be a space in the middle of a word.
        //
        // The tokens add rather than replace, because the row is what the
        // usage view sums and both halves were paid for. `sources` and
        // `grounding` are left alone: the retrieval ran again for the same
        // question and the row already says what grounded it.
        const before = lastMessage as {
          id: string;
          content: string;
          original_message_id: string | null;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          cached_tokens: number | null;
          cache_write_tokens: number | null;
          reasoning_tokens: number | null;
          pass_usage: unknown;
        };
        // A regeneration keeps the answer it replaces. Superseded here rather
        // than before the stream opened: a reply that errors out or comes back
        // empty must leave the conversation exactly as it found it, and the
        // answer already on screen is the thing it would otherwise have taken.
        //
        // The new version points at the chain's *root*, not at the version it
        // is replacing — see 0050 for why the pointer goes where it does.
        if (regenerate) {
          const { error: supersedeError } = await service
            .from("messages")
            .update({ superseded_at: new Date().toISOString() })
            .eq("id", before.id);
          if (supersedeError) {
            console.error("failed to supersede the previous answer", supersedeError);
            return null;
          }
        }

        const { data: inserted, error: insertError } = continuing
          ? await service
              .from("messages")
              .update({
                content: before.content + text,
                prompt_tokens: (before.prompt_tokens ?? 0) + (opts.promptTokens ?? 0),
                completion_tokens: (before.completion_tokens ?? 0) + (opts.completionTokens ?? 0),
                cached_tokens: (before.cached_tokens ?? 0) + (opts.cachedTokens ?? 0),
                cache_write_tokens: (before.cache_write_tokens ?? 0) + (opts.cacheWriteTokens ?? 0),
                reasoning_tokens: (before.reasoning_tokens ?? 0) + (opts.reasoningTokens ?? 0),
                // Concatenated for the same reason the counts add: the row is
                // one reply and both halves were paid for. The second half's
                // passes are numbered from zero again — they are a separate
                // request sequence against a separate prompt — so the array is
                // a record of two runs, not one continuous one.
                pass_usage: [
                  ...(Array.isArray(before.pass_usage) ? before.pass_usage : []),
                  ...opts.passUsage,
                ],
              })
              .eq("id", before.id)
              .select("*")
              .single()
          : await service
              .from("messages")
              .insert({
                session_id: sessionId,
                role: "assistant",
                content: text,
                sender_id: null,
                sources: sources.length > 0 ? sources : null,
                grounding,
                prompt_tokens: opts.promptTokens,
                completion_tokens: opts.completionTokens,
                cached_tokens: opts.cachedTokens,
                cache_write_tokens: opts.cacheWriteTokens,
                reasoning_tokens: opts.reasoningTokens,
                pass_usage: opts.passUsage,
                ...(regenerate
                  ? { original_message_id: before.original_message_id ?? before.id }
                  : {}),
              })
              .select("*")
              .single();
        if (insertError || !inserted) return null;
        // Bump updated_at via the service client (RLS-bypassing) so ordering is
        // correct regardless of who drove the reply.
        const { error: bumpError } = await service
          .from("chat_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", sessionId);
        if (bumpError) console.error("failed to bump chat_sessions.updated_at", bumpError);
        return inserted;
      };

      /**
       * Park the turn and tell the client what it is waiting for.
       *
       * Two events rather than one, and they are different things: `confirm`
       * is a question with an id somebody can answer, and `paused` is the
       * fact that the turn stopped — which is also true when the budget ran
       * out and there is nothing to answer. A client that knows neither
       * ignores both and sees a reply that stops early, which is the honest
       * degradation.
       */
      const announcePause = async (messageId: string | null) => {
        if (!paused) return;
        if (paused.reason === "budget") {
          send({ type: "paused", reason: "budget" });
          return;
        }
        const id = await savePausedTurn(service, {
          sessionId,
          messageId,
          workspaceId: session.workspace_id as string,
          agentId: session.agent_id as string,
          userId: c.get("user").id,
          model,
          paused,
          steps,
        });
        if (!id) {
          send({ type: "error", error: "could not save what the agent asked to do" });
          return;
        }
        send({
          type: "confirm",
          id,
          tool: paused.call?.name ?? "",
          summary: paused.summary ?? "",
          proposal: paused.proposal ?? null,
        });
        send({ type: "paused", reason: "confirmation" });
      };

      try {
        // `runAgentTurn` rather than `streamCompletion` directly, which is the
        // one structural change on this path: the model may now ask for a
        // tool, and the loop that runs it and asks again lives in
        // `lib/harness/loop.ts`. A turn with no tools available, or a model
        // that asks for none, goes through exactly one pass and behaves as it
        // always did.
        const turn = await runChatTurn({
          env,
          request: {
            model,
            messages,
            maxTokens: maxTokensFor(mode),
            temperature: temperatureFor(mode, agent.temperature),
            reasoningEffort: reasoningEffortFor(agent.reasoning_effort),
            // The one caller that shows it. On a model and an effort that
            // deliberate, the alternative is a long pause with nothing on
            // screen, which reads as a product that has stopped working.
            showThinking: true,
            webSearch: agent.web_search ?? false,
          },
          tools,
          ctx: buildToolContext({
            db,
            env,
            workspaceId: session.workspace_id as string,
            agentId: session.agent_id as string,
            userId: c.get("user").id,
            sessionId,
            runtimeLimit,
          }),
          signal,
          send,
          spend,
        });

        steps = turn.steps;
        paused = turn.paused ?? null;
        promptTokens = turn.usage.promptTokens;
        completionTokens = turn.usage.completionTokens;
        cachedTokens = turn.usage.cachedTokens;
        cacheWriteTokens = turn.usage.cacheWriteTokens;
        reasoningTokens = turn.usage.reasoningTokens;
        passUsage = turn.passes;
        // Why the model stopped, already normalised to OpenAI's vocabulary by
        // `lib/completion.ts` — so `"length"` means truncated on either
        // provider. Read off the turn rather than held in a variable: the
        // abort and error paths below never look at it, and the two places
        // that do are both inside this block.
        const finishReason = turn.finishReason;

        if (signal.aborted) {
          deferred(
            c,
            (async () => {
              if (!persisted && spend.text.trim().length > 0) {
                const row = await persistAssistant(spend.text, {
                  promptTokens,
                  completionTokens,
                  cachedTokens,
                  cacheWriteTokens,
                  reasoningTokens,
                  passUsage,
                });
                // The steps belong to an abandoned turn as much as to a
                // finished one, and this branch used to drop them: the row was
                // written with its usage and its `pass_usage`, and nothing was
                // written to `message_steps`. Production, 2026-09-24 17:22 —
                // seven passes, 99,405 prompt tokens, zero step rows, which
                // made the single most expensive reply of the day read as a
                // turn that used no tools at all.
                if (row) await writeSteps(service, row.id, steps);
              }
              await recordSpend();
            })(),
          );
          controller.close();
          return;
        }

        if (spend.text.trim().length > 0) {
          const inserted = await persistAssistant(spend.text, {
            promptTokens,
            completionTokens,
            cachedTokens,
            cacheWriteTokens,
            reasoningTokens,
            passUsage,
          });
          await recordSpend();
          if (!inserted) {
            send({ type: "error", error: "failed to persist assistant message" });
            controller.close();
            return;
          }
          // The account of what the reply did, written against the row it
          // belongs to. After the insert because `message_steps.message_id`
          // has nowhere to point before it, and best-effort inside
          // `writeSteps` because a reply that arrived is worth more than its
          // audit trail.
          await writeSteps(service, inserted.id, steps);

          // Before `done`, which is the client's terminal event.
          if (finishReason === "length") send({ type: "truncated" });
          if (paused) await announcePause(inserted.id);
          send({ type: "done", message: mapMessage(inserted) });

          // Follow-up suggestions: a lightweight second call on the cheapest
          // model, after the answer is already on screen. Skipped on
          // continuations (a half-answer has no meaningful follow-up),
          // regenerations (the question hasn't changed), and truncations
          // (the user needs "Continue" not new questions).
          if (!continuing && !regenerate && finishReason !== "length" && !signal.aborted) {
            try {
              const { questions, tokens: fuTokens } = await generateFollowUps(
                env,
                titleModelFor(model, env),
                question,
                spend.text.slice(0, 800),
              );
              if (questions.length > 0) {
                send({ type: "suggestions", questions });
              }
              if (fuTokens > 0) await recordQuota(c, fuTokens);
            } catch {
              // Suggestions are optional — a failure here must not break the
              // stream or leave the user staring at a spinner.
            }
          }
        } else if (paused) {
          // A turn that asked before it said anything. There is no assistant
          // row to hang the steps off yet, so they ride in the parked turn
          // and are written when it resumes — see `paused_turns.steps`.
          await recordSpend();
          await announcePause(null);
          send({ type: "done" });
        } else {
          await recordSpend();
          send({
            type: "error",
            error: "The model returned an empty response. Please try again.",
          });
        }

        controller.close();
      } catch (err: unknown) {
        // What the turn spent before it threw. `runAgentTurn` reports its
        // totals only by returning, so on this path the counters above are
        // still null and every one of them is a real number that was really
        // billed — see `onPass` in `lib/harness/loop.ts`. Read here, before
        // `recordSpend`, because a zero is a number `recordQuota` refuses.
        const spent = spentUsage(spend);
        promptTokens = spent.promptTokens;
        completionTokens = spent.completionTokens;
        cachedTokens = spent.cachedTokens;
        cacheWriteTokens = spent.cacheWriteTokens;
        reasoningTokens = spent.reasoningTokens;
        passUsage = spend.passes;

        if (isAbort(err, signal)) {
          deferred(
            c,
            (async () => {
              await salvagePartial({
                service,
                spend,
                persisted,
                persist: persistAssistant,
              });
              await recordSpend();
            })(),
          );
          controller.close();
          return;
        }
        console.error("chat stream error", err);
        await recordSpend();
        await salvagePartial({ service, spend, persisted, persist: persistAssistant });
        send({ type: "error", error: explainTurnFailure(err, runtimeLimit) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});

/**
 * What the model is told when a person says no.
 *
 * A refusal is a fact about the world, not an error, and the difference
 * matters to what happens next: told "error", a model retries: told "the
 * person declined", it acknowledges and moves on. It is written as the tool's
 * own result rather than as a new user turn because that is what it is — the
 * answer to the call the model made.
 */
const DECLINED_RESULT =
  "The person declined this. Do not try it again in this turn. Acknowledge it briefly and " +
  "carry on with whatever else was asked.";

const confirmSchema = z.object({ approve: z.boolean() });

// POST /chat/confirm/:id
//
// The second half of a turn that stopped to ask. Everything about it is the
// same machinery as `/chat/stream` — the same loop, the same tools, the same
// persistence — and the only thing that differs is where the conversation
// comes from: `paused_turns.messages` rather than the `messages` table, so the
// model sees exactly what it saw when it asked.
chat.post("/chat/confirm/:id", async (c) => {
  const denied = await guardQuota(c);
  if (denied) return denied;

  const env = c.get("providerEnv") ?? c.env;
  const db = c.get("db");
  const service = serviceClient(c.env);

  const parsed = confirmSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const approve = parsed.data.approve;

  const loaded = await loadPausedTurn(service, c.req.param("id"));
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
  const pause = loaded.pause;

  // Who may answer, which is narrower than who may see. The tool will run
  // with this person's standing — their delivery channels, their RLS — so
  // letting a colleague press the button would run it as somebody who never
  // agreed to it. 0060's read policy is deliberately the wider one; this is
  // the narrower half it said lives here.
  if (pause.userId !== c.get("user").id) {
    return c.json({ error: "this is not yours to answer" }, 403);
  }
  // Through the caller's own client, so a session that has since been deleted
  // or unshared is refused by the same policy that refuses it everywhere else.
  const { data: session } = await db
    .from("chat_sessions")
    .select("*")
    .eq("id", pause.sessionId)
    .maybeSingle();
  if (!session) return c.json({ error: "not found" }, 404);

  // The agent's own tuning, read again rather than carried in the parked row.
  //
  // It matters more than it looks: the two halves of one answer are written
  // into one message, and a second half produced at a different temperature —
  // or in a different mode's length cap — is a paragraph that reads like
  // somebody else finished the sentence. `model` IS carried, because that one
  // must not move even if the agent's setting has; the rest is read fresh so
  // a person who turned the dial between asking and approving gets what they
  // set.
  const { data: agent } = await db
    .from("agents")
    .select("mode, temperature, reasoning_effort, web_search")
    .eq("id", pause.agentId)
    .maybeSingle();
  const mode: "normal" | "brainstorm" = effectiveMode(session, agent ?? {});

  // Claimed before anything runs, and the claim is what makes a double-click
  // safe: the second request finds nothing pending and is refused here rather
  // than sending the same email twice.
  const claimed = await resolvePausedTurn(service, pause.id, approve ? "approved" : "declined");
  if (!claimed) return c.json({ error: "this was already answered" }, 409);

  const signal = c.req.raw.signal;
  /**
   * Raised if anything in this turn discovers the invocation is out of
   * platform budget, so the catch can say so instead of "an error".
   *
   * The resume path never had one. Every ceiling it met therefore reached the
   * person as *"The assistant hit an error. Please try again."* — advice that
   * is wrong in the one way that matters, because trying again runs into the
   * same ceiling. See `lib/runtime-limit.ts`.
   */
  const runtimeLimit = runtimeLimitFlag();
  // `confirmed` for the one call a person has just approved, and only for it —
  // the loop below is handed the same context with it off again, because one
  // yes is one call rather than a standing permission.
  const ctx = buildToolContext({
    db,
    env,
    workspaceId: pause.workspaceId,
    agentId: pause.agentId,
    userId: pause.userId,
    sessionId: pause.sessionId,
    runtimeLimit,
    confirmed: true,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      /**
       * What the resumed turn has produced so far, filled as it runs.
       *
       * The same record `/chat/stream` keeps, and it matters more here: the
       * claim above already marked the row approved — that is the double-click
       * guard — so a second attempt would find nothing to resume. If this
       * request drops what it did, nothing else will ever write it.
       */
      const spend = turnSpend();
      let spendRecorded = false;
      let persisted = false;
      /**
       * One counter write per turn, on every way this stream can end.
       *
       * Read off the passes rather than off the returned turn, which is the
       * whole of what was wrong here: the catch used to charge
       * `{promptTokens: null, completionTokens: null}`, `recordQuota` refuses a
       * zero, and so a resume that failed after several real model calls billed
       * nothing at all for them.
       */
      const recordSpend = async () => {
        if (spendRecorded) return;
        spendRecorded = true;
        const usage = spentUsage(spend);
        await recordQuota(c, (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
      };

      /**
       * Everything that happened before the approval, resolved.
       *
       * Separate from `spend.steps`, which is what the resumed turn adds: the
       * loop is given these as `stepsSoFar` and re-reports none of them, so the
       * two are disjoint and the salvage writes both.
       */
      let carried: AgentStep[] = [];

      /**
       * Where the second half of the answer goes, for the success path and the
       * salvage alike.
       *
       * An assistant row already exists when the model said something before it
       * asked, and the two halves are one reply — written as two rows they
       * would be re-sent to the model next turn as two turns, which is not what
       * it said. This is the same rule, and the same join, that `continue` uses
       * on `/chat/stream`.
       *
       * The token columns are the half that used to be missing from the salvage
       * and present here, which is how production collected assistant rows with
       * every count NULL. One function now, so they cannot disagree again.
       */
      const persistAssistant = async (
        text: string,
        usage: CompletionUsage & { passUsage: PassUsage[] },
      ) => {
        if (persisted) return null;
        persisted = true;
        const existing = pause.messageId;
        const columns = {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          cached_tokens: usage.cachedTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          reasoning_tokens: usage.reasoningTokens,
          // Replaced rather than concatenated, matching the counts above it —
          // this branch has always written what the resumed half cost rather
          // than the whole reply, and a pass list that disagreed with the
          // totals beside it would be worse than a short one.
          pass_usage: usage.passUsage,
        };
        const { data } = existing
          ? await service
              .from("messages")
              .update({ content: await appendedContent(service, existing, text), ...columns })
              .eq("id", existing)
              .select("*")
              .single()
          : await service
              .from("messages")
              .insert({
                session_id: pause.sessionId,
                role: "assistant",
                content: text || "(no reply)",
                sender_id: null,
                ...columns,
              })
              .select("*")
              .single();
        return data ?? null;
      };

      try {
        const tool = approve ? toolByName(pause.toolCall.name) : null;
        const started = Date.now();
        const parsedArgs = parseArguments(pause.toolCall.arguments);
        const result = await (async (): Promise<
          { kind: "ok"; content: string } | { kind: "error"; message: string }
        > => {
          if (!approve) return { kind: "error", message: DECLINED_RESULT };
          if (!tool) return { kind: "error", message: `no tool named ${pause.toolCall.name}` };
          // Through the harness's own runner rather than called directly, which
          // is what this path was doing. Every other tool call in the product
          // is time-boxed; the one a person had just approved was not, so a
          // connected app that hung held the stream open until the client gave
          // up. `runWithTimeout` also delivers the ceiling as a signal, so the
          // tool's own `fetch` is cancelled rather than left running with
          // nobody to receive it — and it answers with an error rather than
          // throwing, which is why the try that used to wrap this is gone.
          const ran = await runWithTimeout(
            tool,
            parsedArgs.ok ? parsedArgs.args : {},
            ctx,
            TOOL_TIMEOUT_MS,
            signal,
          );
          // A tool that asks again having been told yes is a tool that has not
          // read `ctx.confirmed`, which is a bug in the tool rather than a
          // second question for the person. Reported as an error so it is
          // visible instead of parking the turn a second time.
          if (ran.kind === "needs_confirmation") {
            return { kind: "error", message: "this tool asked for confirmation twice" };
          }
          return ran;
        })();

        /**
         * What the model is handed for the call it just approved.
         *
         * Capped, which this path did not do — `loop.ts` puts every other tool
         * result through `MAX_TOOL_OUTPUT_CHARS` and this one went through
         * whole. That was survivable while confirmation was rare; `run_tool`
         * asks on every call, so the tool carrying most of today's traffic was
         * the one tool with no output budget at all. An uncapped result is not
         * paid for once either: it joins the transcript and is re-sent on every
         * later pass of the turn, which with sixteen steps is the expensive
         * end of a square.
         *
         * One string for all three uses below — what the model reads, what the
         * transcript keeps, and the length that is measured — because they were
         * three expressions of the same thing and only two of them agreed.
         */
        const resolved =
          result.kind === "ok"
            ? cap(result.content, MAX_TOOL_OUTPUT_CHARS)
            : `error: ${result.message}`;

        // The pending step, resolved. Its index is kept so the numbering the
        // person already saw does not move under them.
        const steps = pause.steps.map((step, i) =>
          i === pause.steps.length - 1 && step.status === "pending"
            ? {
                ...step,
                status:
                  result.kind === "ok"
                    ? ("ok" as const)
                    : approve
                      ? ("failed" as const)
                      : ("refused" as const),
                resultExcerpt: resolved,
                // The pause wrote this row with no `result_chars`, because at
                // that point nothing had been put in front of the model. Now
                // something has. Leaving it null made every confirmed call
                // invisible to the only measurement that can size the tool
                // budget — and confirmed calls are most of them.
                resultChars: resolved.length,
                durationMs: Date.now() - started,
              }
            : step,
        );
        carried = steps;
        send({
          type: "step",
          index: steps[steps.length - 1]?.index ?? 0,
          tool: pause.toolCall.name,
          status: steps[steps.length - 1]?.status ?? "ok",
          label: pause.toolCall.name,
        });

        const messages: CompletionMessage[] = [
          ...pause.messages,
          { role: "tool", toolCallId: pause.toolCall.id, content: resolved },
        ];

        const { tools } = await capabilitiesFor({
          db,
          env,
          workspaceId: pause.workspaceId,
          userId: pause.userId,
        });

        const turn = await runChatTurn({
          env,
          request: {
            model: pause.model ?? resolveModel(null, env),
            messages,
            maxTokens: maxTokensFor(mode),
            temperature: temperatureFor(mode, agent?.temperature),
            reasoningEffort: reasoningEffortFor(agent?.reasoning_effort),
            showThinking: true,
            webSearch: agent?.web_search ?? false,
          },
          tools,
          // Not `ctx`: the approval covered one call, and a tool the model
          // asks for next has to ask again. Carrying `confirmed` forward
          // would turn one yes into a standing permission.
          ctx: { ...ctx, confirmed: false },
          stepsSoFar: steps,
          signal,
          send,
          spend,
        });

        await recordSpend();

        const inserted = await persistAssistant(turn.text, {
          ...spentUsage(spend),
          passUsage: turn.passes,
        });

        if (!inserted) {
          send({ type: "error", error: "failed to persist assistant message" });
          controller.close();
          return;
        }

        await writeSteps(service, inserted.id, turn.steps);
        await service
          .from("chat_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", pause.sessionId);

        if (turn.paused?.reason === "confirmation") {
          const nextId = await savePausedTurn(service, {
            sessionId: pause.sessionId,
            messageId: inserted.id,
            workspaceId: pause.workspaceId,
            agentId: pause.agentId,
            userId: pause.userId,
            model: pause.model ?? "",
            paused: turn.paused,
            steps: turn.steps,
          });
          if (nextId) {
            send({
              type: "confirm",
              id: nextId,
              tool: turn.paused.call?.name ?? "",
              summary: turn.paused.summary ?? "",
              proposal: turn.paused.proposal ?? null,
            });
            send({ type: "paused", reason: "confirmation" });
          }
        } else if (turn.paused?.reason === "budget") {
          send({ type: "paused", reason: "budget" });
        }

        // Before `done`, exactly as `/chat/stream` does it. A resumed answer
        // can hit the same 4096-token cap the first half can, and without this
        // the second half stops mid-thought with nothing on screen saying so —
        // and no Continue button, because that button is what this event
        // raises.
        if (turn.finishReason === "length") send({ type: "truncated" });

        send({ type: "done", message: mapMessage(inserted) });
        controller.close();
      } catch (err) {
        // The person closed the tab. Not a failure, and reporting it as one
        // was this path's own invention: `/chat/stream` has always had this
        // branch. An error frame written into a stream nobody is reading is
        // harmless; the assistant row claiming the turn broke is not.
        if (isAbort(err, signal)) {
          deferred(
            c,
            (async () => {
              await salvagePartial({
                service,
                spend,
                carried,
                persisted,
                persist: persistAssistant,
              });
              await recordSpend();
            })(),
          );
          controller.close();
          return;
        }
        console.error("chat confirm error", err);
        await recordSpend();
        // The same recovery `/chat/stream` does, and for a stronger reason —
        // see `carried` above.
        await salvagePartial({ service, spend, carried, persisted, persist: persistAssistant });
        send({ type: "error", error: explainTurnFailure(err, runtimeLimit) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

/**
 * The reply so far plus the rest of it, joined with nothing between them.
 *
 * Read back rather than carried through the pause, because the pause may have
 * been answered minutes later by a different request: the row is the only
 * thing that knows what was actually written. Falls back to the new half
 * alone if the row has gone, which is the honest outcome of a message that was
 * deleted while a confirmation was open.
 */
async function appendedContent(
  service: ReturnType<typeof serviceClient>,
  messageId: string,
  addition: string,
): Promise<string> {
  const { data } = await service
    .from("messages")
    .select("content")
    .eq("id", messageId)
    .maybeSingle();
  const before = typeof data?.content === "string" ? data.content : "";
  if (!before) return addition;
  if (!addition) return before;
  return `${before}\n\n${addition}`;
}

export { chat };
