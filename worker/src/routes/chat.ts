import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";
import { serviceClient } from "../lib/supabase";
import { resolveModel, modelSpec, titleModelFor, availableModels } from "../lib/models";
import { streamCompletion, type CompletionMessage } from "../lib/completion";
import { retrieveForAgent } from "../lib/retrieval";
import { selectHistory } from "../lib/history";
import { buildSystemPrefix, temperatureFor, maxTokensFor, reasoningEffortFor } from "../lib/prompt";
import { effectiveMode } from "../lib/session-mode";
import { generateSessionTitle } from "../lib/session-title";
import { deferred } from "../lib/defer";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";

const chat = new Hono<AppEnv>();

const streamChatSchema = z.object({
  sessionId: z.string().min(1),
  /**
   * Finish the reply already at the end of this conversation, rather than
   * answering a new question.
   *
   * A chat reply is capped at `maxTokensFor("normal")` — 1536 tokens, which is
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

// Hard cap on rows pulled from the DB — an upper bound so the query stays cheap.
// The real trimming is done by selectHistory() below against a character budget.
const MSG_HISTORY_LIMIT = 40;

// Per-turn history budget (a cheap char proxy for tokens) and per-message cap.
// Every turn re-sends the surviving history, so without a budget a long chat —
// or one giant pasted message — makes cost grow quadratically. ~16k chars is
// roughly 4k tokens of recent context; a single message is capped at ~4k chars.
const HISTORY_CHAR_BUDGET = 16000;
const PER_MESSAGE_CHAR_CAP = 4000;

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
  const systemPrefix = buildSystemPrefix({
    persona: agent.persona,
    mode,
    docNames,
  });

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

      let full = "";
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
      // Why the model stopped. "length" means it ran into `maxTokensFor` and
      // the answer is cut off mid-thought — which looks, on screen, exactly
      // like an answer that finished. Carried out to the client so it can say
      // so instead of leaving someone to work out that the last sentence has
      // no end.
      let finishReason: string | null = null;

      let persisted = false;
      let spendRecorded = false;

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
      try {
        const events = streamCompletion(
          env,
          {
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
          { signal },
        );

        for await (const event of events) {
          if (event.type === "delta") {
            full += event.text;
            send({ type: "delta", text: event.text });
          } else if (event.type === "thinking") {
            // Forwarded and not kept. The reasoning is context for the answer
            // while somebody is watching it appear, not part of the answer:
            // it is not written to the row, so it is not in the transcript and
            // not re-sent as history on the next turn. Adding it to `full`
            // would put an account of the model's deliberation into the reply
            // itself.
            send({ type: "thinking", text: event.text });
          } else {
            promptTokens = event.usage.promptTokens;
            completionTokens = event.usage.completionTokens;
            cachedTokens = event.usage.cachedTokens;
            // Already normalised to OpenAI's vocabulary by `lib/completion.ts`,
            // so `"length"` means truncated on either provider.
            finishReason = event.finishReason;
          }
        }

        if (signal.aborted) {
          deferred(
            c,
            (async () => {
              if (!persisted && full.trim().length > 0) {
                await persistAssistant(full, { promptTokens, completionTokens, cachedTokens });
              }
              await recordSpend();
            })(),
          );
          controller.close();
          return;
        }

        if (full.trim().length > 0) {
          const inserted = await persistAssistant(full, {
            promptTokens,
            completionTokens,
            cachedTokens,
          });
          await recordSpend();
          if (!inserted) {
            send({ type: "error", error: "failed to persist assistant message" });
            controller.close();
            return;
          }
          // Before `done`, which is the client's terminal event.
          if (finishReason === "length") send({ type: "truncated" });
          send({ type: "done", message: mapMessage(inserted) });
        } else {
          await recordSpend();
          send({
            type: "error",
            error: "The model returned an empty response. Please try again.",
          });
        }

        controller.close();
      } catch (err: unknown) {
        const isAbort = (err as { name?: string } | null)?.name === "AbortError" || signal.aborted;
        if (isAbort) {
          deferred(
            c,
            (async () => {
              if (!persisted && full.trim().length > 0) {
                await persistAssistant(full, { promptTokens, completionTokens, cachedTokens });
              }
              await recordSpend();
            })(),
          );
          controller.close();
          return;
        }
        console.error("chat stream error", err);
        await recordSpend();
        send({ type: "error", error: "The assistant hit an error. Please try again." });
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

export { chat };
