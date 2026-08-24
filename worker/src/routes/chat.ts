import { Hono } from "hono";
import { z } from "zod";
import type OpenAI from "openai";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";
import { serviceClient } from "../lib/supabase";
import { resolveModel } from "../lib/models";
import { createOpenAI } from "../lib/openai";
import { embedTexts } from "../lib/embeddings";
import { buildContextBlock } from "../lib/rag";
import { selectHistory } from "../lib/history";
import { buildSystemPrefix, temperatureFor, maxTokensFor } from "../lib/prompt";
import { effectiveMode } from "../lib/session-mode";
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

// How many chunks to retrieve, and the cosine-similarity floor below which a
// chunk is treated as irrelevant and dropped. text-embedding-3-small scores
// on-topic content well above this and clearly-unrelated content below it, so
// the floor removes noise without starving genuine matches. The RAG block is
// re-sent every turn and rides after the cacheable prefix, so it never caches —
// keeping the count tight cuts recurring input directly.
const RAG_MATCH_COUNT = 6;
const RAG_MIN_SIMILARITY = 0.25;

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

  // Documents that actually grounded this reply, deduped in relevance order.
  // Persisted with the assistant message so the UI can show real citations.
  const sourceNames: string[] = [];
  // Retrieved knowledge for this turn. Kept OUT of the persona/system prefix and
  // the persisted history so that prefix stays byte-identical across turns and
  // OpenAI's automatic prompt cache can discount the bulk of the input.
  let ragBlock = "";
  // Embedding the question costs tokens too. Carried to the end of the turn and
  // recorded with the completion's, so one reply means one counter write.
  let embeddingTokens = 0;

  // Load only the agent's document *names* here (newest first) — that's all the
  // manifest needs so the agent knows what it can see and never denies having
  // files. Stored `content` is deliberately NOT fetched on the hot path: it is
  // only used by the no-match fallback below, so we load it lazily there and
  // avoid pulling every document's full body on every single turn.
  let docNames: string[] = [];
  let bundleIds: string[] = [];
  {
    const { data: bundleRows, error: bundleError } = await db
      .from("agent_bundles")
      .select("bundle_id")
      .eq("agent_id", session.agent_id);
    bundleIds = bundleError
      ? []
      : (bundleRows ?? []).map((r: { bundle_id: string }) => r.bundle_id);
    if (bundleIds.length > 0) {
      const { data: docRows, error: docError } = await db
        .from("documents")
        .select("name")
        .in("bundle_id", bundleIds)
        .order("created_at", { ascending: false });
      if (!docError) {
        docNames = (docRows ?? []).map((r: { name: string }) => r.name);
      }
    }
  }
  const hasKnowledge = docNames.length > 0;

  // Semantic retrieval over the bundles attached to this agent. Best-effort:
  // any failure falls back to persona-only so the reply is never blocked.
  if (hasKnowledge) {
    try {
      const embedded = await embedTexts(c.env.OPENAI_API_KEY, [lastMessage.content]);
      embeddingTokens += embedded.tokens;
      const [queryEmbedding] = embedded.vectors;
      if (queryEmbedding) {
        const { data: matches, error: matchError } = await db.rpc("match_chunks", {
          p_agent_id: session.agent_id,
          p_query_embedding: queryEmbedding,
          p_match_count: RAG_MATCH_COUNT,
          p_min_similarity: RAG_MIN_SIMILARITY,
        });
        if (matchError) {
          console.error("match_chunks failed", matchError);
        } else if (matches && matches.length > 0) {
          const typed = matches as Array<{ document_name: string; content: string }>;
          ragBlock = buildContextBlock(
            typed.map((m) => ({ documentName: m.document_name, content: m.content })),
          );
          if (ragBlock) {
            for (const m of typed) {
              if (m.document_name && !sourceNames.includes(m.document_name)) {
                sourceNames.push(m.document_name);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("retrieval failed (continuing persona-only)", e);
    }
  }

  // Fallback: no chunk matched (common for "summarize the file" / "what's in
  // the doc" style questions that don't embed close to any single passage), yet
  // the agent does have documents. Ground on their stored content directly —
  // newest first, capped by the same char budget — so it answers from the file
  // instead of claiming it can't read it.
  if (!ragBlock && hasKnowledge) {
    const { data: docRows, error: docError } = await db
      .from("documents")
      .select("name,content")
      .in("bundle_id", bundleIds)
      .order("created_at", { ascending: false });
    const withContent = docError
      ? []
      : ((docRows ?? []) as Array<{ name: string; content: string | null }>).filter(
          (d) => d.content && d.content.trim().length > 0,
        );
    if (withContent.length > 0) {
      ragBlock = buildContextBlock(
        withContent.map((d) => ({ documentName: d.name, content: d.content as string })),
      );
      if (ragBlock) {
        for (const d of withContent) {
          if (!sourceNames.includes(d.name)) sourceNames.push(d.name);
        }
      }
    }
  }

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
  const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrefix },
    ...priorTurns,
    ...(ragBlock ? [{ role: "system" as const, content: ragBlock }] : []),
    ...(latestTurn ? [latestTurn] : []),
  ];

  const model = resolveModel(agent.model, c.env);
  const openai = createOpenAI(c.env);
  const signal = c.req.raw.signal;
  const service = serviceClient(c.env);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      let full = "";
      // Token usage arrives in a final usage-only chunk (empty choices) when
      // stream_options.include_usage is set. Captured for the usage dashboard.
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      // How much of `promptTokens` OpenAI served from its automatic prompt
      // cache — a subset of that count, not an addition. This is the only
      // evidence that the cacheable-prefix assembly above is actually working;
      // without it a change that silently breaks the cache costs real money and
      // shows up nowhere. Unlike the transcription usage field, `cached_tokens`
      // is properly typed by the pinned SDK, so no fallback is needed here.
      let cachedTokens: number | null = null;

      let persisted = false;
      let spendRecorded = false;

      // One counter write per turn, on every way this stream can end — a reply
      // that was cut off still cost what it cost. Guarded because several of
      // those endings overlap (an abort mid-loop also lands in the catch).
      const recordSpend = async () => {
        if (spendRecorded) return;
        spendRecorded = true;
        await recordQuota(
          c,
          embeddingCost(embeddingTokens) + (promptTokens ?? 0) + (completionTokens ?? 0),
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
            sources: sourceNames.length > 0 ? sourceNames : null,
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
        const completion = await openai.chat.completions.create(
          {
            model,
            messages: openaiMessages,
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: maxTokensFor(mode),
            ...(temperatureFor(mode) !== undefined ? { temperature: temperatureFor(mode) } : {}),
          },
          { signal },
        );

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            full += delta;
            send({ type: "delta", text: delta });
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? null;
            completionTokens = chunk.usage.completion_tokens ?? null;
            cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null;
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
