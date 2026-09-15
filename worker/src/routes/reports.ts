import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapDocument } from "../lib/dto";
import { resolveModel } from "../lib/models";
import { complete, totalTokens } from "../lib/completion";
import type { CompletionMessage } from "../lib/completion";
import { retrieveForAgent } from "../lib/retrieval";
import { selectHistory } from "../lib/history";
import { buildSystemPrefix, maxTokensFor, temperatureFor, reasoningEffortFor } from "../lib/prompt";
import { reportTitle, reportFileName } from "../lib/report";
import { EXCERPT_LIMIT, safeName } from "../lib/extract";
import { getDocStore } from "../lib/docstore";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";

const reports = new Hono<AppEnv>();

const reportSchema = z.object({
  // What the report should be. Capped for the same reason a chat message is:
  // this rides in the prompt, and an instruction long enough to matter is a
  // document that belongs in a bundle rather than in a text field.
  instruction: z.string().trim().min(1).max(2000),
  bundleId: z.string().min(1),
});

// Same budget as a chat turn. A report re-sends the conversation it came out of
// for the same reason a reply does — and pays for it the same way.
const HISTORY_CHAR_BUDGET = 16000;
const PER_MESSAGE_CHAR_CAP = 4000;
const MSG_HISTORY_LIMIT = 40;

// POST /sessions/:id/report — write the conversation up as a document.
//
// One model call, deliberately. An agentic loop would turn a turn into three to
// five calls with the quota check stranded in the middle of them, which is the
// reason chat has no tools; asking once for the whole document keeps the shape
// this product meters in — guard before, record after — and is also the only
// shape in which a refusal can still be a 402 rather than a half-written file.
//
// Nothing here is embedded. A report is born with no chunks, which the Knowledge
// tab shows as "Not indexed", and `POST /documents/:id/reindex` is how someone
// decides it is worth the storage. That is not an omission: embedding every
// report at birth costs roughly forty times its row, and whether a report is
// worth retrieving later is a question only its reader can answer — the same
// argument chat uploads make about which bundle a dropped file belongs in.
reports.post("/sessions/:id/report", async (c) => {
  const db = c.get("db");

  const parsed = reportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { instruction, bundleId } = parsed.data;

  // Before anything is loaded, embedded or generated.
  const denied = await guardQuota(c);
  if (denied) return denied;

  // Whose key answers. `guardQuota` sets this only when the caller is past their
  // allowance and the workspace is carrying it from here.
  const env = c.get("providerEnv") ?? c.env;

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("*")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (sessionError) return c.json({ error: "failed to load session" }, 500);
  if (!session) return c.json({ error: "not found" }, 404);

  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("*")
    .eq("id", session.agent_id)
    .maybeSingle();
  if (agentError) return c.json({ error: "failed to load agent" }, 500);
  if (!agent) return c.json({ error: "not found" }, 404);

  // Asked before the model is, and that order is the whole point of the query.
  // RLS would refuse the insert at the end anyway, but by then the report has
  // been generated and paid for — so a bundle the caller cannot write to would
  // cost them a full report to be told "not found".
  const { data: bundle, error: bundleError } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bundleError) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);

  const { data: recentDesc, error: messagesError } = await db
    .from("messages")
    .select("*")
    .eq("session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(MSG_HISTORY_LIMIT);
  if (messagesError) return c.json({ error: "failed to load messages" }, 500);

  const rows = (recentDesc ?? []).slice().reverse();
  const turns = rows.map((m: { role: string; content: string }) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  // The instruction is the question retrieval answers, not the last thing said
  // in the conversation: "write this up for the board" is what the report is
  // about, and the history is only there to say what "this" refers to.
  const { docNames, ragBlock, embeddingTokens } = await retrieveForAgent(
    db,
    env,
    session.agent_id,
    instruction,
    turns,
  );

  const history = selectHistory(turns, {
    maxChars: HISTORY_CHAR_BUDGET,
    perMessageCap: PER_MESSAGE_CHAR_CAP,
  });

  const messages: CompletionMessage[] = [
    {
      role: "system",
      content: buildSystemPrefix({ persona: agent.persona, mode: "report", docNames }),
    },
    ...history,
    ...(ragBlock ? [{ role: "system" as const, content: ragBlock }] : []),
    { role: "user", content: instruction },
  ];

  let markdown: string;
  let usage;
  try {
    const result = await complete(
      env,
      {
        model: resolveModel(agent.model, env),
        messages,
        maxTokens: maxTokensFor("report"),
        temperature: temperatureFor("report", agent.temperature),
        reasoningEffort: reasoningEffortFor(agent.reasoning_effort),
      },
      { signal: c.req.raw.signal },
    );
    markdown = result.text.trim();
    usage = result.usage;
  } catch (e) {
    console.error("report generation failed", e);
    // The embedding above was really bought. Charging only for it is the honest
    // answer to a turn that got that far and no further.
    await recordQuota(c, embeddingCost(embeddingTokens));
    return c.json({ error: "failed to write the report" }, 502);
  }

  if (markdown.length === 0) {
    await recordQuota(c, embeddingCost(embeddingTokens) + totalTokens(usage));
    return c.json({ error: "the model returned an empty report" }, 502);
  }

  const title = reportTitle(markdown);
  const name = reportFileName(title, new Date().toISOString().slice(0, 10));
  const encoded = new TextEncoder().encode(markdown);
  // `encode` always allocates a fresh, exactly-sized buffer, so this is the
  // whole file rather than a view into something larger — and never the
  // SharedArrayBuffer the `ArrayBufferLike` type leaves room for.
  const bytes = encoded.buffer as ArrayBuffer;

  // The row keeps the name a person reads; only the key is sanitised, which is
  // the split the upload route already makes. A Turkish title survives into the
  // Knowledge tab and turns into underscores no further than the object store.
  const r2Key = `${bundleId}/${crypto.randomUUID()}-${safeName(name)}`;
  try {
    await getDocStore(c.env).put(r2Key, bytes, { contentType: "text/markdown" });
  } catch (e) {
    console.error("failed to store report", e);
    await recordQuota(c, embeddingCost(embeddingTokens) + totalTokens(usage));
    return c.json({ error: "failed to store the report; check the server logs" }, 500);
  }

  // The caller's client, not the service one: writing a document is
  // `can_write_in_workspace` (0021), and a viewer who can read this session must
  // still be refused here. RLS answers that refusal by matching no rows.
  const { data: doc, error } = await db
    .from("documents")
    .insert({
      bundle_id: bundleId,
      name,
      size: encoded.byteLength,
      r2_key: r2Key,
      content: markdown.slice(0, EXCERPT_LIMIT),
    })
    .select("id,name,size,created_at")
    .single();

  if (error || !doc) {
    try {
      await getDocStore(c.env).delete(r2Key);
    } catch (e) {
      console.error("r2 rollback failed", e);
    }
    console.error("failed to insert report row", error);
    await recordQuota(c, embeddingCost(embeddingTokens) + totalTokens(usage));
    return c.json({ error: "failed to save the report" }, 500);
  }

  await recordQuota(c, embeddingCost(embeddingTokens) + totalTokens(usage));

  return c.json(mapDocument({ ...doc, document_chunks: [{ count: 0 }] }), 201);
});

export { reports };
