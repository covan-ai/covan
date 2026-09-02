import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import type { Bindings } from "../../types";
import type { Entitlements } from "../entitlements";
import { embeddingCost } from "../entitlements";
import { retrieveForAgent } from "../retrieval";
import { selectHistory } from "../history";
import { buildSystemPrefix, maxTokensFor, temperatureFor } from "../prompt";
import { resolveModel } from "../models";
import { createOpenAI } from "../openai";
import { decryptSecret } from "../secret-box";
import { lookupEmail, postMessage } from "./api";

/**
 * A question asked in Slack, answered by the agent, in the thread.
 *
 * The shape is `routes/chat.ts` without the stream: retrieve, assemble, spend,
 * persist, reply. The differences are all consequences of there being no
 * session and no caller —
 *
 * - **Who is asking** comes from a Slack user id, which means nothing here. It
 *   is resolved to a Covan account by email, once, and stored. Somebody with no
 *   account is told so rather than answered as the installer; see 0044.
 * - **The conversation** is the Slack thread. One thread is one
 *   `chat_sessions` row, so the exchange shows up in Covan as an ordinary
 *   conversation — searchable, exportable, and visible to the team when it
 *   happened in a channel.
 * - **Nothing streams.** Slack has no notion of a partial message worth the
 *   three edits per second it would take to fake one.
 */

/** How much history one thread carries into a turn. Matches `routes/chat.ts`. */
const HISTORY_CHAR_BUDGET = 16000;
const PER_MESSAGE_CHAR_CAP = 4000;
const MSG_HISTORY_LIMIT = 40;

/** How much of the first question becomes the conversation's title in Covan. */
const TITLE_LIMIT = 80;

export type SlackEvent = {
  type: "app_mention" | "message";
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
};

export type InstallationRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  bot_user_id: string;
  secret_ciphertext: string;
  agent_id: string | null;
};

export type HandleDeps = {
  /** Service-role client: an event has no caller for RLS to resolve. */
  db: SupabaseClient;
  env: Bindings;
  entitlements: Entitlements;
  fetchImpl: typeof fetch;
};

/**
 * Whether this event is one we answer at all.
 *
 * Three of the four rejections below are the app hearing itself. Slack delivers
 * a bot's own messages back to it, `message_changed` arrives when anybody edits
 * anything, and a thread the app has replied in produces an event per reply —
 * so an integration that answers everything it is told about answers itself,
 * forever, at the workspace's expense.
 */
export function shouldAnswer(event: SlackEvent, botUserId: string): boolean {
  if (event.bot_id) return false;
  if (!event.user || event.user === botUserId) return false;
  // Edits, deletions, joins, file shares — anything with a subtype is a message
  // about a message, not somebody asking something.
  if (event.subtype) return false;
  if (!event.text?.trim() || !event.channel || !event.ts) return false;

  if (event.type === "app_mention") return true;
  // A direct message needs no mention: there is nobody else in the room.
  return event.type === "message" && event.channel_type === "im";
}

/** Slack wraps a user mention as `<@U123>`; the agent should not read its own id. */
export function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

/**
 * The whole exchange for one event.
 *
 * Every early return posts something into the thread. A silent integration is
 * the failure people report as "it's broken" with nothing to go on, so every
 * refusal here says what to do about it.
 */
export async function handleSlackEvent(
  installation: InstallationRow,
  event: SlackEvent,
  deps: HandleDeps,
): Promise<void> {
  if (!shouldAnswer(event, installation.bot_user_id)) return;

  const token = await decryptSecret(installation.secret_ciphertext, deps.env.ROUTINE_SECRET_KEY);
  const channel = event.channel!;
  // A reply to a top-level message starts the thread; a reply inside one joins
  // it. `thread_ts` is absent on the first message, and `ts` is what becomes
  // the thread's id.
  const threadTs = event.thread_ts ?? event.ts!;
  const say = (text: string) =>
    postMessage(deps.fetchImpl, token, { channel, threadTs, text }).catch((err) => {
      console.error("slack post failed", err);
    });

  if (!installation.agent_id) {
    await say(
      "No agent is set for Slack yet. An admin can choose one on the Integrations page in Covan.",
    );
    return;
  }

  const userId = await resolveIdentity(installation, event.user!, token, deps);
  if (!userId) {
    await say(
      "I don't know who you are in Covan. Your Slack email has to match a member of this " +
        "workspace — ask an admin to invite that address, then try again.",
    );
    return;
  }

  const verdict = await deps.entitlements.check(userId);
  if (!verdict.allowed) {
    await say("Your monthly Covan allowance is used up, so I can't answer this one.");
    return;
  }

  const { data: agent, error: agentError } = await deps.db
    .from("agents")
    .select("id,name,persona,model,mode,workspace_id")
    .eq("id", installation.agent_id)
    .eq("workspace_id", installation.workspace_id)
    .maybeSingle();
  if (agentError || !agent) {
    await say("The agent this Slack app points at is gone. Pick another one in Covan.");
    return;
  }

  const question = stripMention(event.text!, installation.bot_user_id);
  if (!question) return;

  const sessionId = await sessionForThread(installation, event, {
    ...deps,
    agentId: agent.id,
    userId,
    title: question.slice(0, TITLE_LIMIT),
    // A question asked in a channel was asked in front of everyone, so the
    // conversation it creates is shared. A DM is a private room, and 0008's
    // default is the right one for it.
    visibility: event.channel_type === "im" ? "private" : "shared",
  });
  if (!sessionId) {
    await say("I couldn't open a conversation for this thread. Nothing was lost — try again.");
    return;
  }

  const { error: askError } = await deps.db.from("messages").insert({
    session_id: sessionId,
    role: "user",
    content: question,
    sender_id: userId,
  });
  if (askError) {
    console.error("slack: failed to record the question", askError);
    await say("I couldn't record that question, so I haven't answered it. Try again.");
    return;
  }

  const { data: recentDesc } = await deps.db
    .from("messages")
    .select("role,content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(MSG_HISTORY_LIMIT);
  const history = selectHistory(
    ((recentDesc ?? []) as Array<{ role: string; content: string }>)
      .slice()
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { maxChars: HISTORY_CHAR_BUDGET, perMessageCap: PER_MESSAGE_CHAR_CAP },
  );

  // The same history the turn is assembled from. `retrievalQuery` reads the
  // turns before the last one, so a follow-up in a Slack thread carries its
  // subject the same way a follow-up in the chat screen does.
  const retrieval = await retrieveForAgent(deps.db, deps.env, agent.id, question, history);

  const mode: "normal" | "brainstorm" = agent.mode === "brainstorm" ? "brainstorm" : "normal";
  const systemPrefix = buildSystemPrefix({
    persona: agent.persona,
    mode,
    docNames: retrieval.docNames,
  });

  // Same assembly as the chat route: the stable prefix and prior turns first so
  // OpenAI's automatic prompt cache can discount them, with the volatile
  // retrieved block riding immediately before the latest question.
  const priorTurns = history.slice(0, -1);
  const latestTurn = history[history.length - 1];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrefix },
    ...priorTurns,
    ...(retrieval.ragBlock ? [{ role: "system" as const, content: retrieval.ragBlock }] : []),
    ...(latestTurn ? [latestTurn] : []),
  ];

  let completion;
  try {
    completion = await createOpenAI(deps.env).chat.completions.create({
      model: resolveModel(agent.model, deps.env),
      messages,
      temperature: temperatureFor(mode),
      max_tokens: maxTokensFor(mode),
    });
  } catch (err) {
    console.error("slack completion failed", err);
    // The spend still happened up to the failure — the embedding, at least.
    await deps.entitlements.record(userId, embeddingCost(retrieval.embeddingTokens));
    await say("Something went wrong reaching the model. Try again in a moment.");
    return;
  }

  const answer = completion.choices[0]?.message?.content?.trim() ?? "";
  const promptTokens = completion.usage?.prompt_tokens ?? 0;
  const completionTokens = completion.usage?.completion_tokens ?? 0;
  // How much of `promptTokens` OpenAI served from its own cache — a subset of
  // that count, not an addition. It is the only evidence that the cacheable
  // prefix assembled above is actually working.
  const cachedTokens = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  // One counter write per turn, whichever way the rest of this goes.
  await deps.entitlements.record(
    userId,
    embeddingCost(retrieval.embeddingTokens) + promptTokens + completionTokens,
  );

  if (!answer) {
    await say("I don't have an answer for that one.");
    return;
  }

  const { error: replyError } = await deps.db.from("messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: answer,
    sources: retrieval.sources.length > 0 ? retrieval.sources : null,
    // Nullable, and the constraint in 0039 only allows it on an assistant row.
    // Recording it here too is what keeps covan#44's "did anything the team
    // wrote come close?" honest — a question asked in Slack is still a question
    // this workspace could not answer from its own documents.
    grounding: retrieval.grounding,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
  });
  // Posted either way. A reply that reached Slack and not the database is a
  // worse outcome than one that reached both, but it is far better than an
  // answer the person paid for and never saw.
  if (replyError) console.error("slack: failed to record the answer", replyError);

  await say(withCitations(answer, retrieval.sources));
}

/**
 * The documents an answer stood on, as a line under it.
 *
 * The chat screen shows sources as chips beside the reply; Slack has no such
 * affordance, so they become text. Named rather than linked: `documents` has no
 * public URL, and a synced document's `external_url` points at Notion or Drive,
 * where the reader may not have access — a link that 403s is worse than a name.
 */
function withCitations(answer: string, sources: Array<{ name: string }>): string {
  if (sources.length === 0) return answer;
  return `${answer}\n\n_From: ${sources.map((s) => s.name).join(", ")}_`;
}

/**
 * Which Covan account this Slack user is, or null.
 *
 * Looked up once and stored, because the alternative is two Slack API calls on
 * every message. The match is by email, and it is deliberately strict: an
 * address Slack reports that belongs to no member of *this* workspace resolves
 * to nobody, rather than to whoever happens to have it elsewhere.
 */
async function resolveIdentity(
  installation: InstallationRow,
  slackUserId: string,
  botToken: string,
  deps: HandleDeps,
): Promise<string | null> {
  const { data: known } = await deps.db
    .from("slack_identities")
    .select("user_id")
    .eq("installation_id", installation.id)
    .eq("slack_user_id", slackUserId)
    .maybeSingle();
  if (known?.user_id) return known.user_id as string;

  const email = await lookupEmail(deps.fetchImpl, botToken, slackUserId);
  if (!email) return null;

  const { data: profile } = await deps.db
    .from("profiles")
    .select("id")
    .ilike("email", email.replace(/[%_]/g, "\\$&"))
    .maybeSingle();
  if (!profile?.id) return null;

  // Being in Covan is not enough — they have to be in *this* workspace, or a
  // stranger with a matching address would be answered with this team's
  // knowledge.
  const { data: membership } = await deps.db
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", installation.workspace_id)
    .eq("user_id", profile.id)
    .maybeSingle();
  if (!membership) return null;

  await deps.db.from("slack_identities").insert({
    installation_id: installation.id,
    slack_user_id: slackUserId,
    user_id: profile.id,
  });

  return profile.id as string;
}

/** The conversation for this thread, creating it on the first question. */
async function sessionForThread(
  installation: InstallationRow,
  event: SlackEvent,
  deps: HandleDeps & {
    agentId: string;
    userId: string;
    title: string;
    visibility: "private" | "shared";
  },
): Promise<string | null> {
  const channel = event.channel!;
  const threadTs = event.thread_ts ?? event.ts!;

  const { data: existing } = await deps.db
    .from("slack_threads")
    .select("session_id")
    .eq("installation_id", installation.id)
    .eq("channel_id", channel)
    .eq("thread_ts", threadTs)
    .maybeSingle();
  if (existing?.session_id) return existing.session_id as string;

  const { data: session, error } = await deps.db
    .from("chat_sessions")
    .insert({
      agent_id: deps.agentId,
      user_id: deps.userId,
      workspace_id: installation.workspace_id,
      title: deps.title,
      kind: "chat",
      visibility: deps.visibility,
    })
    .select("id")
    .single();
  if (error || !session) {
    console.error("slack: failed to open a session", error);
    return null;
  }

  const { error: linkError } = await deps.db.from("slack_threads").insert({
    installation_id: installation.id,
    channel_id: channel,
    thread_ts: threadTs,
    session_id: session.id,
  });
  if (linkError) {
    // Two events from the same thread can race here — Slack delivers fast and
    // this is two round trips. The loser reads the winner's row rather than
    // leaving a second session that would split the conversation in half.
    const { data: raced } = await deps.db
      .from("slack_threads")
      .select("session_id")
      .eq("installation_id", installation.id)
      .eq("channel_id", channel)
      .eq("thread_ts", threadTs)
      .maybeSingle();
    if (raced?.session_id) {
      await deps.db.from("chat_sessions").delete().eq("id", session.id);
      return raced.session_id as string;
    }
    console.error("slack: failed to link the thread", linkError);
  }

  return session.id as string;
}
