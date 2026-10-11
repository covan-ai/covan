import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { complete, type CompletionMessage, type CompletionUsage } from "../completion";
import { resolveModel } from "../models";
import { deliver, deliveryDepsFrom, type DeliveryChannel } from "../routines/delivery";
import { bareHost } from "./outcome";
import type { BrowserTaskRow, FinishedTask } from "./poller";

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
 * with one exception it is told about in the message itself: a login wall,
 * where pointing at the browser is the whole of the answer.
 */
const SYSTEM = [
  "A browser agent was asked to do something on the web and has finished.",
  "Write the answer to the person who asked, in their own language, as if you had just",
  "looked it up yourself. Do not mention browsers, tasks, agents or tools unless the",
  "message below tells you to, and do not apologise for the delay. If the browser did",
  "not manage it, say plainly what stopped it. Keep to what the browser actually",
  "reported — do not add facts it did not give you.",
].join(" ");

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
    const { content, usage } = await phrase(
      row,
      outcome,
      env,
      model,
      agent?.temperature as number | null,
    );

    const { data: message, error } = await db
      .from("messages")
      .insert({
        session_id: row.session_id,
        role: "assistant",
        content,
        // Nobody sent it. The same null `sender_id` an ordinary assistant
        // reply carries.
        sender_id: null,
        model,
        outcome: "answered",
        // Bookkeeping on the row, NOT a second charge against the allowance.
        // The 137,000 tokens taken when the task was created already stand
        // for $0.17, which dwarfs this completion; recording it against the
        // quota again would bill twice for one piece of work. What this does
        // is stop the row claiming it cost nothing.
        prompt_tokens: usage?.promptTokens ?? null,
        completion_tokens: usage?.completionTokens ?? null,
      })
      .select("id")
      .single();

    if (error || !message) {
      console.error("could not write a browser task's answer into the conversation", row.id, error);
      return;
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
 * What the model is shown, by how the run ended.
 *
 * A login wall is the one ending a person can fix with their own hands while
 * the browser is still there (Task 1.5's take-over), so that message has one
 * job: name the site and say the panel beside the conversation is waiting. One
 * sentence, through the same model call as every other answer — which is what
 * puts it in the language the person asked in. A block says what stopped it.
 * Everything else, including every v2 task, is answered as before.
 */
function brief(row: BrowserTaskRow, outcome: FinishedTask): string {
  const asked = [`What was asked: ${row.task}`, ""];
  const reported = outcome.output ? ["What the browser reported:", outcome.output, ""] : [];

  if (outcome.reported?.status === "login_required") {
    return [
      ...asked,
      `The browser stopped because ${siteOf(outcome)} requires the person to sign in, and it has no sign-in for it.`,
      "It is still open in the browser panel beside this conversation, waiting for them to sign in there themselves.",
      "",
      ...reported,
      "Tell them in one sentence, in the language they asked in, which site wants them to sign in",
      "and that the browser panel is waiting for them.",
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
function fallback(row: BrowserTaskRow, outcome: FinishedTask): string {
  if (outcome.reported?.status === "login_required") {
    return (
      `${siteOf(outcome)} needs you to sign in — the browser beside this conversation is ` +
      "waiting for you to do it there."
    );
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
): Promise<{ content: string; usage: CompletionUsage | null }> {
  if (!outcome.output && outcome.reported?.status !== "login_required") {
    return { content: fallback(row, outcome), usage: null };
  }

  const messages: CompletionMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: brief(row, outcome) },
  ];

  try {
    const { text, usage } = await complete(env, {
      model,
      messages,
      ...(typeof temperature === "number" ? { temperature } : {}),
    });
    return { content: text.trim() || fallback(row, outcome), usage };
  } catch (err) {
    console.error("could not phrase a browser task's answer; delivering it raw", row.id, err);
    return { content: fallback(row, outcome), usage: null };
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
    const { data: channel } = await db
      .from("delivery_channels")
      .select("id, kind, secret_ciphertext")
      .eq("user_id", row.user_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!channel) return;

    await deliver(
      channel as DeliveryChannel,
      { subject: "Your browser task is done", body: content },
      deliveryDepsFrom(env),
      { event: "agent.browser_task" },
    );
  } catch (err) {
    console.error("could not notify about a finished browser task", row.id, err);
  }
}
