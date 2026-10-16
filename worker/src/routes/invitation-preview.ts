import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";

/**
 * What the `/invite` page can say before anybody has signed in.
 *
 * Somebody who opens an invitation email on a fresh browser used to be told
 * only "You've been invited" — not to what, by whom, or with which address to
 * sign up. The id and token from the email's link are the proof 0090 already
 * treats as the invitee's, so holding them is enough to learn the workspace's
 * name, the inviter's, the role and the address the account has to be.
 *
 * Unauthenticated, so it sits outside `api` and behind the `standard` limiter
 * like everything else. It accepts nothing: `invitation_preview` (0114) is a
 * read, and accepting is still a button pressed while signed in. A wrong pair,
 * an accepted invitation and a missing one all answer the same 404.
 *
 * The service role, because there is no caller yet and `invitation_preview` is
 * granted to nobody else (no definer function answers the anon key, 0084). It
 * makes exactly one call, and the function answers only for the id and token
 * together.
 *
 * POST rather than GET so the token travels in a body and not in a URL that
 * access logs keep.
 */
const invitationPreview = new Hono<AppEnv>();

const schema = z.object({
  id: z.string().uuid(),
  token: z.string().min(1).max(200),
});

invitationPreview.post("/invitations/preview", async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "not an invitation" }, 404);

  const { data, error } = await serviceClient(c.env).rpc("invitation_preview", {
    p_invite_id: parsed.data.id,
    p_token: parsed.data.token,
  });
  if (error) {
    console.error("could not read an invitation preview", error);
    return c.json({ error: "could not read the invitation" }, 500);
  }

  const row = (
    (data ?? []) as {
      workspace_name: string;
      inviter_name: string | null;
      email: string;
      role: string;
      open: boolean;
    }[]
  )[0];
  if (!row) return c.json({ error: "not an invitation" }, 404);

  return c.json({
    workspaceName: row.workspace_name,
    inviterName: row.inviter_name ?? null,
    email: row.email,
    role: row.role,
    open: row.open,
  });
});

export { invitationPreview };
