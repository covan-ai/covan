import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../types";
import { canSendEmail, sendEmail } from "../lib/email";
import { quotaSupportEmail } from "../lib/emails/support";
import { appUrlOf } from "../lib/emails/send";
import { readKeyHints } from "../lib/keys/store";
import { getRateLimiter } from "../lib/ratelimit";
import { getActiveWorkspaceId } from "../lib/workspace";

/**
 * Where the second door at the quota wall leads.
 *
 * Sent rather than deferred, unlike every other mail in this Worker. `notify`
 * (`lib/emails/send.ts`) exists for courtesies — somebody has been removed, an
 * account has been closed — where the operation has already happened and the
 * mail must not be able to fail it. Here the mail *is* the operation. Somebody
 * at the wall is deciding whether this product is worth paying for, and a
 * message that quietly does not arrive is worse than one that is refused. So
 * this route calls `sendEmail` directly, awaits it, and answers 502 if it
 * throws — never `notify`.
 *
 * Everything in the mail except the message text itself is read here, from the
 * caller's own session and their own workspace's own rows. None of it comes
 * from the request body: somebody who can type JSON must not be able to tell
 * us they run a hundred-seat account.
 */

/**
 * Where these go when nothing says otherwise.
 *
 * A default rather than a required secret, so there is nothing to forget on
 * deploy and no unconfigured state to handle. The address is already public in
 * this repository (`src/routes/license.tsx`), so naming it here exposes nothing
 * new. A self-hoster who has registered their own metered entitlements can
 * reach this form and should set `SUPPORT_EMAIL`.
 */
export const DEFAULT_SUPPORT_EMAIL = "efe@covan.app";

/** Long enough to explain a need, short enough not to be a payload. */
const MAX_MESSAGE = 4000;

const schema = z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE) });

const support = new Hono<AppEnv>();

support.post("/support/quota", async (c) => {
  const user = c.get("user");

  // Checked before anything else is read or spent. The wall is a place people
  // arrive at frustrated, and a send button there without a limit is a send
  // button that gets pressed eleven times — this has to stop that before a
  // single query runs, not after building the mail it would have sent.
  const verdict = await getRateLimiter(c.env, "standard").check(user.id);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "too many messages — try again shortly" }, 429);
  }

  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: `a message is required, up to ${MAX_MESSAGE} characters` }, 400);
  }

  if (!canSendEmail(c.env)) {
    return c.json({ error: "this deployment cannot send mail" }, 501);
  }

  // Everything below is read here rather than taken from the body. Somebody who
  // can type JSON must not be able to tell us they are a hundred-seat account.
  const db = c.get("db");
  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const [{ data: workspace }, { data: profile }, { data: members }, hints, quota] =
    await Promise.all([
      db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
      // The same lookup `notifyInvitee` (`routes/invitations.ts`) makes for the
      // inviter's display name — `profiles.name`, not the auth user's own
      // metadata, which nothing else in this codebase reads.
      db.from("profiles").select("name").eq("id", user.id).maybeSingle(),
      // Read as rows rather than `{ count: 'exact', head: true }` — the same
      // choice `DELETE /workspace/members/me` makes, and for the same reason: a
      // workspace has a handful of members, not a table's worth, so paying for a
      // second aggregate query buys nothing a `.length` does not already give.
      db.from("workspace_members").select("user_id").eq("workspace_id", workspaceId),
      readKeyHints(c.env, workspaceId),
      c.get("entitlements").snapshot(user.id),
    ]);

  const email = quotaSupportEmail({
    to: c.env.SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL,
    from: {
      email: user.email ?? "unknown",
      name: (profile?.name as string | null) ?? null,
    },
    workspace: {
      id: workspaceId,
      name: (workspace?.name as string | null) ?? "unnamed",
      memberCount: (members ?? []).length,
    },
    quota: { used: quota.used, limit: quota.limit ?? 0 },
    hasWorkspaceKey: Boolean(hints.openai || hints.anthropic),
    appUrl: appUrlOf(c),
    message: parsed.data.message,
  });

  try {
    await sendEmail(email, {
      fetchImpl: fetch.bind(globalThis),
      apiKey: c.env.RESEND_API_KEY,
      from: c.env.RESEND_FROM,
    });
  } catch (err) {
    console.error("could not send a quota support message", err);
    return c.json({ error: "could not send your message — please email us directly" }, 502);
  }

  return c.json({ ok: true });
});

export { support };
