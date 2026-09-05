import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";
import { serviceClient } from "../lib/supabase";
import { resolveModel } from "../lib/models";
import { streamCompletion, type CompletionMessage } from "../lib/completion";
import { retrieveForAgent } from "../lib/retrieval";
import { selectHistory } from "../lib/history";
import { buildSystemPrefix, temperatureFor, maxTokensFor } from "../lib/prompt";
import { effectiveMode } from "../lib/session-mode";
import { generateSessionTitle } from "../lib/session-title";
import { deferred } from "../lib/defer";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";

const chat = new Hono<AppEnv>();

const streamChatSchema = z.object({
  sessionId: z.string().min(1),
});

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

  const parsed = streamChatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { sessionId } = parsed.data;

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
  if (!lastMessage || lastMessage.role !== "user") {
    return c.json({ error: "no user message to respond to" }, 400);
  }

  const mode: "normal" | "brainstorm" = effectiveMode(session, agent);

  // What the agent knows, assembled for this question: the manifest of document
  // names, the grounding block, what grounded it, and which path found it. This
  // was written out here until a Slack thread needed to ask an agent the same
  // question — see `lib/retrieval.ts` for why one copy rather than two.
  const { docNames, ragBlock, sources, grounding, embeddingTokens } = await retrieveForAgent(
    db,
    c.env,
    session.agent_id,
    lastMessage.content,
    rows.map((m: { role: string; content: string }) => ({
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
    rows.map((m: { role: string; content: string }) => ({
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
  ];

  const model = resolveModel(agent.model, c.env);
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
  const titling = session.title ? null : generateSessionTitle(c.env, model, lastMessage.content);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

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
        const { data: inserted, error: insertError } = await service
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
          c.env,
          {
            model,
            messages,
            maxTokens: maxTokensFor(mode),
            temperature: temperatureFor(mode),
          },
          { signal },
        );

        for await (const event of events) {
          if (event.type === "delta") {
            full += event.text;
            send({ type: "delta", text: event.text });
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
