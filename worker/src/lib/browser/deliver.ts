import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { complete, type CompletionMessage, type CompletionUsage } from "../completion";
import { resolveModel } from "../models";
import { deliver, deliveryDepsFrom } from "../routines/delivery";
import { credentialCoversHost, hasSavedCredential } from "./credentials";
import { bareHost } from "./outcome";
import type { BrowserTaskRow, FinishedTask } from "./poller";
import {
  CONFIRMABLE_COLUMNS,
  readyForDelivery,
  type ConfirmableChannel,
} from "../routines/address-confirmation";
import { completionSpend, entitlementsFor, spends } from "../entitlements";

/**
 * The answer, arriving in the conversation minutes after the turn that asked
 * for it ended.
 *
 * **Why a new message and not a resumed turn.** The design doc wanted the
 * paused turn picked up and continued, and that is not available from here:
 * `POST /chat/confirm/:id` reads the caller's own RLS client and the
 * approving user off the request and streams SSE back to a browser, and the
 * cron Worker has none of those. What it does have is the pattern routines
 * already run on — a service-role client, an explicit workspace, and one
 * model call — so that is what this is.
 *
 * **One model call, and no tools.** The browser did the work. This turns its
 * output into a sentence that answers the question that was asked, which is
 * phrasing rather than reasoning. A tool loop here would be a second agent
 * turn nobody asked for, on a Worker whose whole subrequest budget is fifty.
 *
 * **Nothing here throws.** It is called from `settleBrowserTask` after the row has
 * already reached a terminal status, so a throw would lose the delivery
 * without making the task claimable again. Every failure is logged and
 * degrades to something a person can still read.
 */

/**
 * The model is told to answer the question, not to describe the browser —
 * with one exception it is told about in the brief itself: a login wall,
 * where pointing at the browser is the whole of the answer.
 *
 * **"In the language of their message", and their message as the user turn.**
 * Measured 2026-10-11 on gpt-4.1-mini: "in their own language" with only the
 * English brief to go on answered a login wall in Spanish, and quoting the
 * person's words inside the brief as "the language to write in" made it worse
 * — Spanish for an English speaker in 19 of 20 runs. With the brief in the
 * system message and the person's own words as the user message, 60 runs
 * across English, Turkish and German, answers and login walls, all came back
 * in the person's language. The per-case instructions in `brief` say nothing
 * about language for the same reason: every mention of it was a cue to pick
 * one.
 *
 * **Their message is not an instruction.** The one that started a task often
 * asks for more than this task's result ("review the repo, the site and
 * Tasklet, then write it up"). On 2026-10-11 the chat model, phrasing two
 * covan.app results against such a message, answered it instead — with
 * made-up tool calls in YAML and XML, and the results never shown. Hence the
 * last sentence. Measured on gpt-4.1-mini it changes nothing about the
 * language (Turkish login walls came back Turkish 19/20 with it, 18/20
 * without) and every message that started a task was answered with the
 * result.
 *
 * **And then their message was taken away.** On 2026-10-11 21:32, on
 * claude-sonnet-4-5, the message that started a GitHub task asked for
 * "GitHub, then covan.app, then tasklet.ai, and compare". With it as the only
 * user turn the phrasing call did what it asked: it dropped most of a 4,154
 * character report on the repo and wrote about the other two sites — a
 * funding round, customer logos, usage figures — none of which any browser
 * had seen. The sentence above did not hold on Claude. So the phrasing call
 * no longer sees their words at all: `languageOf` reads them, in a call of its
 * own, for the one thing they were there for, and this call is told the
 * language by name ("Write in Turkish."), with the brief as its user turn.
 * Naming the language is not the cue that failed above — that was "the
 * language to write in" pointing at quoted words, which left the model to
 * guess. And `strayReply` checks what comes back.
 */
const SYSTEM = [
  "A browser looked something up for the person and has finished. Pass on what it found.",
  "The brief below is everything that was looked at: every fact, site and page you mention",
  "must come from it. Do not describe any site or page it does not contain, and never say",
  "you looked at anything else. Start by naming in a few words what was looked at, then give",
  "what it found, keeping every useful detail, unless the brief asks for one sentence.",
  "Do not mention browsers, tasks, agents or tools unless the brief tells you to, and do",
  "not apologise for the delay. If it did not manage it, say plainly what stopped it.",
  "Write no tool calls or code, only the answer.",
].join(" ");

/** What the answer is told about its language, by name or without one. */
function writeIn(language: string | null): string {
  return language
    ? `Write in ${language}.`
    : "Write in the language the person uses with you; if you cannot tell, write in English.";
}

/**
 * Which language the person wrote in, by name, from their own message.
 *
 * A call of its own, so the call that writes the answer never sees their
 * words (see `SYSTEM`). One word back, checked to be a name and nothing else:
 * an answer that is a sentence, or carries anything but letters, is treated
 * as not knowing, which is a plainer prompt rather than a lost delivery.
 */
const LANGUAGE_SYSTEM =
  "Name the language the person's message is written in. Answer with its English name only " +
  "(for example: Turkish), nothing else.";
const LANGUAGE_NAME = /^[A-Za-z][A-Za-z ()-]{1,30}$/;

async function languageOf(
  env: RoutineEnv,
  model: string,
  words: string,
  rowId: string,
): Promise<{ language: string | null; usage: CompletionUsage | null }> {
  try {
    const { text, usage } = await complete(env, {
      model,
      messages: [
        { role: "system", content: LANGUAGE_SYSTEM },
        { role: "user", content: words },
      ],
      maxTokens: 10,
    });
    const name = text.trim().replace(/[.!]+$/, "");
    return { language: LANGUAGE_NAME.test(name) ? name : null, usage };
  } catch {
    console.warn("could not tell the language of a browser task's question", rowId);
    return { language: null, usage: null };
  }
}

/** Two calls' tokens as one row's, for the two columns the row keeps. */
function plus(a: CompletionUsage | null, b: CompletionUsage | null): CompletionUsage | null {
  if (!a || !b) return a ?? b;
  const sum = (x: number | null, y: number | null) =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    ...b,
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
  };
}

/**
 * Whether a phrased answer went past what the browser reported, in the two
 * ways it has:
 *
 * - it names a site that is in neither the task nor the report — on
 *   2026-10-11 21:32, `tasklet.ai`, in the answer to a task about a GitHub
 *   repo (`www.` aside, and case aside);
 * - it carries tool-call markup — on 2026-10-11, made-up calls in YAML and
 *   XML in place of two answers.
 *
 * Either way the report itself is delivered instead (`fallback`): plainer, in
 * the browser's language rather than theirs, and true.
 */
const HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/gi;
const TOOL_MARKUP =
  /<\/?(?:function_calls|invoke|tool_call|tool_use|parameter)\b|```(?:ya?ml|xml)\b[\s\S]*?\b(?:tool|invoke|function)\b/i;

function strayReply(text: string, row: BrowserTaskRow, outcome: FinishedTask): boolean {
  if (TOOL_MARKUP.test(text)) return true;
  const known = [row.task, outcome.output ?? "", outcome.reported?.host ?? ""]
    .join(" ")
    .toLowerCase();
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  return [...text.matchAll(HOST)].some(([host]) => {
    // A file name or a version is not a site: only hosts whose last label is
    // letters reach here, but `README.md` would; a name ending in a common
    // file extension is left alone.
    if (/\.(md|txt|json|ts|tsx|js|py|csv|pdf|png|jpe?g|yml|yaml|toml|sql|html?)$/i.test(host)) {
      return false;
    }
    return !known.includes(bare(host));
  });
}

export async function deliverBrowserTask(
  row: BrowserTaskRow,
  outcome: FinishedTask,
  env: RoutineEnv,
  db: SupabaseClient,
): Promise<void> {
  try {
    /**
     * The conversation may be gone. `browser_tasks.session_id` cascades, so
     * deleting a session deletes the task row — but a browser already running
     * at the provider carries on, and the poller can reach here in the window
     * between the two. Checked rather than assumed, because the alternative
     * is a foreign-key error in a cron log.
     */
    const { data: session } = await db
      .from("chat_sessions")
      .select("id")
      .eq("id", row.session_id)
      .maybeSingle();
    if (!session) {
      console.warn("browser task finished for a conversation that is gone", row.id);
      return;
    }

    const { data: agent } = await db
      .from("agents")
      .select("model, temperature, reasoning_effort")
      .eq("id", row.agent_id)
      .maybeSingle();

    const model = resolveModel((agent?.model as string | null) ?? null, env);
    const saved = await savedLoginState(row, outcome, env, db);
    const words = needsModel(outcome) ? await theirWords(row, db) : null;
    const told = words ? await languageOf(env, model, words, row.id) : null;
    const phrased = await phrase(
      row,
      outcome,
      env,
      model,
      agent?.temperature as number | null,
      saved,
      told?.language ?? null,
    );
    const content = phrased.content;
    const usage = plus(told?.usage ?? null, phrased.usage);

    const { data: message, error } = await db
      .from("messages")
      .insert({
        session_id: row.session_id,
        role: "assistant",
        content,
        // Nobody sent it. The same null `sender_id` an ordinary assistant
        // reply carries.
        sender_id: null,
        // No `grounding`, on purpose, and decided rather than forgotten
        // (covan-cloud#316). `'none'` would say a retrieval ran and nothing the
        // team wrote came close — the coverage screen reports that as its own
        // line — and no retrieval ran here: this row answers no question. The
        // question that started the task was asked in the turn that called
        // `browse`, and that turn's own row records what grounded it, so a
        // value here would count one question twice. Null is the column's
        // "nobody recorded one", which is the true thing to say.
        model,
        outcome: "answered",
        // What the row cost, and below, what the workspace is charged for it.
        prompt_tokens: usage?.promptTokens ?? null,
        completion_tokens: usage?.completionTokens ?? null,
      })
      .select("id")
      .single();

    if (error || !message) {
      console.error("could not write a browser task's answer into the conversation", row.id, error);
      return;
    }

    // Charged. This used to be left off on the reasoning that the task's
    // provisional hold already stood for far more — but the hold is settled
    // to the provider's own figure (`settle_credits`), which knows nothing of
    // these two completions, so after settling nobody paid for them. Filed
    // against the message and NOT the task: a ledger row carrying the task's
    // id would be folded into what the settle makes equal the provider's bill,
    // and refunded.
    const charge = spends(completionSpend(model, usage, "summary"));
    if (charge.length > 0) {
      try {
        await entitlementsFor(env).record(row.workspace_id, charge, {
          userId: row.user_id,
          sessionId: row.session_id,
          messageId: message.id as string,
        });
      } catch (err) {
        console.error("could not charge for a browser task's answer", row.id, err);
      }
    }

    // So the conversation sorts to the top of somebody's list, which is the
    // only signal a person gets if they are not watching.
    await db
      .from("chat_sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", row.session_id);

    await notify(row, env, db, content);
  } catch (err) {
    // Called after the row reached a terminal status, so there is nothing to
    // retry and nothing to be gained by failing the tick.
    console.error("browser task delivery failed", row.id, err);
  }
}

/**
 * The site a login wall names, or a description when the run named none.
 *
 * Narrowed by `bareHost` exactly as settle narrows what it stores in
 * `signin_host`, so the message and the panel's prompt name the same site —
 * and a model's `https://LinkedIn.com/login` is not repeated into the
 * conversation as though it were a site's name.
 */
function siteOf(outcome: FinishedTask): string {
  return bareHost(outcome.reported?.host ?? null) ?? "a site it needed";
}

/**
 * What a login wall has to do with a saved login (Task 2.3, ruling R32):
 *
 * - `failed`: the run CARRIED a saved login (`browser_tasks.credential_id`)
 *   and it was for the site that walled it. That login is what did not work —
 *   a changed password, usually — and "sign in" is the wrong thing to ask of
 *   somebody who already gave it. The offer is to update it.
 * - `unused`: the run carried none for this site, but a login is saved for it
 *   (`hasSavedCredential`, R27). It was never tried — the model named no
 *   `site`, a hand-back ran without it, `site` named another host — so it has
 *   not failed, and asking again is what would use it. Today's sign-in wording,
 *   plus that.
 * - null: anything else, including every ending that is not a login wall and a
 *   wall with no usable host.
 *
 * Only `credential_id` can say `failed`. A login that is merely saved and
 * blamed anyway sends the person to re-type a correct password and round the
 * same wall again; that was the reason the run now writes down what it carried.
 *
 * **A failed read is today's wording.** Both lookups throw on a read error,
 * and this file does not throw; the cost of not knowing is the plainer
 * sentence, not a lost delivery. Logged as a fixed sentence and the row id.
 * Up to four reads, all only on a login wall, through the service-role client
 * this delivery already holds.
 */
type SavedLoginState = "failed" | "unused" | null;

/** How much of the person's message `languageOf` is shown: enough to tell a language, no more. */
const WORDS_SHOWN = 400;

/**
 * The message the person sent to start the task, for the one thing the
 * answer cannot know without it: which language to answer in. Read by
 * `languageOf`, and by nothing that writes the answer.
 *
 * `row.task` is not their words. The chat model wrote it for the browser
 * agent, in English whatever the person wrote, so "answer in the language
 * they asked in" with only the task to go on is a guess. On 2026-10-11 the
 * guess for an English conversation was Spanish ("El sitio … requiere que
 * inicies sesión"); for a Turkish one it would usually be English.
 *
 * **The one that started it, not the latest.** The row does not name that
 * message, so it is the last one the person sent, and did not edit away, at
 * or before the task was created. The latest one is somebody talking while
 * the browser works — "start them again", "scan them in order" — and on
 * 2026-10-11 the phrasing call answered that instead of delivering the
 * result, twice. A retry asks about its original's message: it was created
 * by a button, later, and whatever was said in between was not the question.
 * A row that carries no `created_at` (a test's) gets the latest, as before.
 *
 * Read only when a model call will happen. **A failed read is today's
 * prompt**, never a lost delivery: nothing in this file throws.
 */
async function theirWords(row: BrowserTaskRow, db: SupabaseClient): Promise<string | null> {
  try {
    const startedAt = await askedAt(row, db);
    let query = db
      .from("messages")
      .select("content")
      .eq("session_id", row.session_id)
      .eq("role", "user")
      .is("superseded_at", null);
    if (startedAt) query = query.lte("created_at", startedAt);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("could not read the person's words for a browser task's answer", row.id);
      return null;
    }
    const content = typeof data?.content === "string" ? data.content.trim() : "";
    return content ? content.slice(0, WORDS_SHOWN) : null;
  } catch {
    console.warn("could not read the person's words for a browser task's answer", row.id);
    return null;
  }
}

/**
 * When the question was asked: the task's own `created_at`, or for a retry its
 * original's. A retry is never itself retried (`browser_tasks_retry_of_idx`,
 * `controls.ts`), so one hop reaches the task the person's message started.
 * The extra read is only for a retry; if it fails, the retry's own time is
 * still a bound that leaves out everything said after the retry.
 */
async function askedAt(row: BrowserTaskRow, db: SupabaseClient): Promise<string | null> {
  const own = typeof row.created_at === "string" ? row.created_at : null;
  if (!row.retry_of) return own;
  const { data, error } = await db
    .from("browser_tasks")
    .select("created_at")
    .eq("id", row.retry_of)
    .maybeSingle();
  if (error || typeof data?.created_at !== "string") return own;
  return data.created_at;
}

/** Whether `phrase` will ask the model: the same test it makes before doing so. */
function needsModel(outcome: FinishedTask): boolean {
  return Boolean(outcome.output) || outcome.reported?.status === "login_required";
}

async function savedLoginState(
  row: BrowserTaskRow,
  outcome: FinishedTask,
  env: RoutineEnv,
  db: SupabaseClient,
): Promise<SavedLoginState> {
  if (outcome.reported?.status !== "login_required") return null;
  const host = bareHost(outcome.reported.host ?? null);
  if (!host) return null;
  try {
    if (
      row.credential_id &&
      (await credentialCoversHost(env, { credentialId: row.credential_id, host }, { db }))
    ) {
      return "failed";
    }
    const saved = await hasSavedCredential(
      env,
      { agentId: row.agent_id, userId: row.user_id, host },
      { db },
    );
    return saved ? "unused" : null;
  } catch {
    console.warn("could not ask whether a login was saved for a browser task's site", row.id);
    return null;
  }
}

/**
 * What the model is shown, by how the run ended.
 *
 * A login wall is the one ending a person can fix with their own hands while
 * the browser is still there (Task 1.5's take-over), so that message has one
 * job: name the site and say the panel beside the conversation is waiting. One
 * sentence, through the same model call as every other answer — which is what
 * puts it in the language the person asked in. A wall the run's own saved
 * login could not get past (`saved === "failed"`, Task 2.3) is the same one
 * sentence about a different repair: the saved login didn't get past the sign-in
 * (it may be a code, an SMS or a passkey step), and the offer is to update it. A wall on a site whose saved login the run never
 * carried (`"unused"`) is today's sentence and one true clause more: asking
 * again would use it. A block says what stopped it. Everything else,
 * including every v2 task, is answered as before.
 */
function brief(row: BrowserTaskRow, outcome: FinishedTask, saved: SavedLoginState): string {
  const asked = [`What was asked: ${row.task}`, ""];
  const reported = outcome.output ? ["What the browser reported:", outcome.output, ""] : [];

  // Task 2.3, R32: the run carried a saved login for this site and the wall
  // stood anyway, so the saved login is what to fix — a changed password,
  // usually.
  if (outcome.reported?.status === "login_required" && saved === "failed") {
    return [
      ...asked,
      `The browser stopped because ${siteOf(outcome)} requires signing in, and the saved login for it didn't get past the sign-in.`,
      "It is still open in the browser panel beside this conversation.",
      "",
      ...reported,
      "Tell them in one sentence that the saved login for",
      `${siteOf(outcome)} didn't get past the sign-in, and offer to update it.`,
    ].join("\n");
  }

  if (outcome.reported?.status === "login_required") {
    return [
      ...asked,
      `The browser stopped because ${siteOf(outcome)} requires the person to sign in, and it has no sign-in for it.`,
      "It is still open in the browser panel beside this conversation, waiting for them to sign in there themselves.",
      "",
      ...reported,
      "Tell them in one sentence which site wants them to sign in",
      "and that the browser panel is waiting for them.",
      ...(saved === "unused"
        ? [
            // The panel's button, not "ask again": a model that left `site`
            // out once will leave it out again, and in the 2026-10-11 e2e that
            // promise was a loop. The card's "Try again with the saved login"
            // binds it whatever the model does.
            `A login is saved for ${siteOf(outcome)}, but this run was not given it: add, in the same`,
            "sentence, that the browser panel can try again with the saved login.",
          ]
        : []),
    ].join("\n");
  }

  if (outcome.reported?.status === "blocked") {
    return [
      ...asked,
      ...reported,
      "It reports that something stopped it before it could finish. Say in one sentence what stopped it.",
    ].join("\n");
  }

  return [
    ...asked,
    ...reported,
    outcome.status === "finished"
      ? "It reports that it succeeded."
      : "It reports that it did NOT succeed. Say what stopped it.",
  ].join("\n");
}

/**
 * What is delivered when the model cannot be asked: the output itself, or for
 * a login wall a sentence that still names the site and the panel, because
 * that ending has no output to fall back on and is the one the person can act
 * on.
 */
function fallback(row: BrowserTaskRow, outcome: FinishedTask, saved: SavedLoginState): string {
  if (outcome.reported?.status === "login_required" && saved === "failed") {
    return `The saved login for ${siteOf(outcome)} didn't get past the sign-in — would you like to update it?`;
  }
  if (outcome.reported?.status === "login_required") {
    return saved === "unused"
      ? `${siteOf(outcome)} needs you to sign in — the browser beside this conversation is ` +
          "waiting for you to do it there, or to try again there with your saved login."
      : `${siteOf(outcome)} needs you to sign in — the browser beside this conversation is ` +
          "waiting for you to do it there.";
  }
  return (
    outcome.output ??
    `I could not finish "${row.task}" — ${outcome.error ?? "the browser stopped without an answer"}.`
  );
}

/**
 * The output as a sentence, or the output itself.
 *
 * No model call when there is nothing to phrase: a task that was given up on
 * has an `error` and no `output`, and paying for a completion to rewrite
 * "this took too long" is paying twice for a failure. A login wall is the
 * exception — it has no output and is still worth a sentence in the person's
 * language. And if the call fails, the raw output is returned rather than
 * nothing — it is what the person wanted, just less polished.
 */
async function phrase(
  row: BrowserTaskRow,
  outcome: FinishedTask,
  env: RoutineEnv,
  model: string,
  temperature: number | null | undefined,
  saved: SavedLoginState,
  language: string | null,
): Promise<{ content: string; usage: CompletionUsage | null }> {
  if (!needsModel(outcome)) {
    return { content: fallback(row, outcome, saved), usage: null };
  }

  // The brief is the user turn, and their words are nowhere in this call; the
  // language is named instead (see `SYSTEM`).
  const messages: CompletionMessage[] = [
    { role: "system", content: `${SYSTEM} ${writeIn(language)}` },
    { role: "user", content: brief(row, outcome, saved) },
  ];

  try {
    const { text, usage } = await complete(env, {
      model,
      messages,
      ...(typeof temperature === "number" ? { temperature } : {}),
    });
    const said = text.trim();
    if (said && strayReply(said, row, outcome)) {
      console.warn("a browser task's answer went past its report; delivering the report", row.id);
      return { content: fallback(row, outcome, saved), usage };
    }
    return { content: said || fallback(row, outcome, saved), usage };
  } catch (err) {
    console.error("could not phrase a browser task's answer; delivering it raw", row.id, err);
    return { content: fallback(row, outcome, saved), usage: null };
  }
}

/**
 * A nudge through whatever channel this person already set up.
 *
 * Best-effort and deliberately simple. `notifyOwner` in
 * `lib/routines/executor.ts` is the other way to do this and it is
 * routine-only — it reads `routines.delivery_channel_id`, and a chat session
 * has not got one. So this takes the person's OLDEST channel, which is the
 * one they set up first and the one a single-channel account has anyway, and
 * it consults no preference: `send_email` is the precedent for agent-driven
 * delivery and it checks none either, because the person asked for the work.
 *
 * The answer is already in the conversation by the time this runs, so a
 * failure here costs a nudge and nothing else.
 */
async function notify(
  row: BrowserTaskRow,
  env: RoutineEnv,
  db: SupabaseClient,
  content: string,
): Promise<void> {
  try {
    const { data: first } = await db
      .from("delivery_channels")
      .select(CONFIRMABLE_COLUMNS)
      .eq("user_id", row.user_id)
      .is("disabled_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!first) return;
    const channel = await readyForDelivery(env, first as ConfirmableChannel);

    await deliver(
      channel,
      { subject: "Your browser task is done", body: content },
      deliveryDepsFrom(env),
      { event: "agent.browser_task" },
    );
  } catch (err) {
    console.error("could not notify about a finished browser task", row.id, err);
  }
}
