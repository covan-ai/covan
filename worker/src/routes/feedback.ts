import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { canSendEmail } from "../lib/email";
import { feedbackEmail } from "../lib/emails/feedback";
import { appUrlOf, notify } from "../lib/emails/send";
import { getRateLimiter } from "../lib/ratelimit";

const feedback = new Hono<AppEnv>();

/**
 * 4000 is the check constraint on `feedback.message` in 0041. Repeated here on
 * purpose rather than left to Postgres: a body that trips a constraint comes
 * back as a 500 with a message about a relation, and the person who just typed
 * four thousand characters deserves to be told which end to cut.
 */
const MAX_MESSAGE = 4000;
const MAX_PATH = 200;

const sendSchema = z.object({
  message: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(MAX_MESSAGE)),
  kind: z.enum(["problem", "idea", "other"]).optional(),
  path: z.string().max(2000).optional(),
  /**
   * The reply this is about, when the note started as a thumb under an answer.
   * A uuid or nothing: 0042 refuses an id the caller cannot read, so what this
   * check buys is a 400 with a reason instead of a 500 from a type error.
   */
  messageId: z.string().uuid().optional(),
});

/**
 * The path out of whatever the client sent, or null.
 *
 * The dialog sends `location.pathname`, but this is the one field on the row
 * the client chooses, and a client can send anything. A full URL would carry a
 * query string and a fragment — a share token, a search someone typed — into a
 * table that exists to hold one paragraph of prose. So the URL is parsed and
 * only its path survives; anything unparseable that already looks like a path
 * is kept as-is, and anything else is dropped rather than guessed at.
 */
function pathOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).pathname.slice(0, MAX_PATH);
  } catch {
    // Not a URL. A bare path is what the dialog actually sends, so keep it —
    // minus anything after it — and drop whatever else this was.
    if (!raw.startsWith("/")) return null;
    return raw.split(/[?#]/)[0].slice(0, MAX_PATH);
  }
}

// POST /feedback — one paragraph, addressed to whoever runs this install.
//
// Written through the caller's own client, so 0041's insert policy is what
// enforces "your own name, your own workspace". `user_id` comes from the
// verified token and `workspace_id` is resolved here rather than accepted from
// the body: neither is something the client should get to choose, and the
// policy refuses it either way.
feedback.post("/feedback", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { message, kind, path, messageId } = parsed.data;

  // Null is a normal answer, not a failure: somebody mid-onboarding, or who
  // has just left their last workspace, still has something to say.
  const workspaceId = await callerWorkspaceId(c);

  const { data, error } = await db
    .from("feedback")
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      kind: kind ?? "other",
      message,
      path: pathOf(path),
      message_id: messageId ?? null,
    })
    .select("id, created_at")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to record feedback" }, 500);
  }

  await tellTheOperator(c, {
    workspaceId,
    kind: kind ?? "other",
    path: pathOf(path),
    messageId: messageId ?? null,
    message,
  });

  return c.json({ id: data.id, createdAt: Date.parse(data.created_at as string) }, 201);
});

/**
 * Mail the note to `FEEDBACK_EMAIL`, when this install has set one.
 *
 * The row is the record and is already written; this is a courtesy about it,
 * so it goes through `notify` — deferred past the response, unable to fail
 * the send the person just pressed. Off unless configured, unlike the quota
 * form's `SUPPORT_EMAIL`: a default address here would have every self-hosted
 * install mailing its users' notes to Covan through its own Resend account.
 *
 * Bounded per person by the expensive tier, under its own key, so a dialog
 * pressed in a loop fills the table rather than an inbox.
 */
async function tellTheOperator(
  c: Context<AppEnv>,
  note: {
    workspaceId: string | null;
    kind: "problem" | "idea" | "other";
    path: string | null;
    messageId: string | null;
    message: string;
  },
): Promise<void> {
  const to = c.env ? c.env.FEEDBACK_EMAIL?.trim() : undefined;
  if (!to || !canSendEmail(c.env)) return;

  const user = c.get("user");
  const verdict = await getRateLimiter(c.env, "expensive").check(`feedback-mail:user:${user.id}`);
  if (!verdict.allowed) return;

  const db = c.get("db");
  const [{ data: profile }, { data: workspace }] = await Promise.all([
    db.from("profiles").select("name").eq("id", user.id).maybeSingle(),
    note.workspaceId
      ? db.from("workspaces").select("name").eq("id", note.workspaceId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  notify(
    c,
    feedbackEmail({
      to,
      from: { email: user.email ?? "unknown", name: (profile?.name as string | null) ?? null },
      workspace: note.workspaceId
        ? { id: note.workspaceId, name: (workspace?.name as string | null) ?? "unnamed" }
        : null,
      kind: note.kind,
      path: note.path,
      messageId: note.messageId,
      appUrl: appUrlOf(c),
      message: note.message,
    }),
  );
}

export { feedback };
