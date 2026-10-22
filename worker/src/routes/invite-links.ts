import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { serviceClient } from "../lib/supabase";
import { generateInviteToken, inviteLinkUrl } from "../lib/invite-token";
import { appUrlOf } from "../lib/emails/send";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";

/**
 * Invite links (0129): "Or share a link that works for 7 days · Copy link"
 * in the invite dialog (A25), and the door it opens on `/invite` (A23).
 *
 * Making, listing and revoking go through the caller's own client, so
 * `invite_links`' admin policies decide; the token is minted here, shown once
 * in the answer and stored as its hash. Joining is `accept_invite_link`, for a
 * signed-in person with a confirmed address. The preview before sign-in is
 * the service role's, holding the token — `invitationPreview`'s arrangement.
 *
 * Neither making a link nor joining with one is something an API key may do:
 * both create access that outlives the key (`lib/api-key-rule.ts`).
 */
const inviteLinks = new Hono<AppEnv>();

const createSchema = z.object({ role: z.enum(["member", "viewer"]).default("member") });

type LinkRow = {
  id: string;
  role: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  uses: number;
};

const LINK_COLUMNS = "id, role, created_by, created_at, expires_at, revoked_at, uses";

function mapLink(r: LinkRow) {
  return {
    id: r.id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: Date.parse(r.created_at),
    expiresAt: Date.parse(r.expires_at),
    uses: r.uses,
  };
}

// GET /invite-links — the links still working, newest first. Admins only, by
// policy: a member's list is empty.
inviteLinks.get("/invite-links", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json([]);
  const { data, error } = await c
    .get("db")
    .from("invite_links")
    .select(LINK_COLUMNS)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) {
    console.error("failed to load invite links", error);
    return c.json({ error: "failed to load invite links" }, 500);
  }
  return c.json(((data ?? []) as LinkRow[]).map(mapLink));
});

// POST /invite-links — a new link, its URL in the answer and nowhere else.
inviteLinks.post("/invite-links", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "make an invite link");
  if (refusal) return c.json(refusal, 403);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const { token, tokenHash } = await generateInviteToken();
  const { data, error } = await c
    .get("db")
    .from("invite_links")
    .insert({
      workspace_id: workspaceId,
      role: parsed.data.role,
      token_hash: tokenHash,
      created_by: c.get("user").id,
    })
    .select(LINK_COLUMNS)
    .single();
  if (error || !data) {
    // An insert RLS refuses is a 42501, which for this table means "not an admin".
    if (error?.code === "42501") {
      return c.json({ error: "only admins can make invite links" }, 403);
    }
    console.error("failed to make an invite link", error);
    return c.json({ error: "failed to make the link" }, 500);
  }
  return c.json({ ...mapLink(data as LinkRow), url: inviteLinkUrl(appUrlOf(c), token) }, 201);
});

// DELETE /invite-links/:id — turn a link off before its week is up.
inviteLinks.delete("/invite-links/:id", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("invite_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .is("revoked_at", null)
    .select("id");
  if (error) {
    console.error("failed to revoke an invite link", error);
    return c.json({ error: "failed to turn the link off" }, 500);
  }
  if (!data || data.length === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

const tokenSchema = z.object({ token: z.string().min(1).max(200) });

// POST /invite-links/accept — join with a link.
inviteLinks.post("/invite-links/accept", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "join a workspace");
  if (refusal) return c.json(refusal, 403);

  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "this link does not work" }, 400);

  const { data, error } = await c
    .get("db")
    .rpc("accept_invite_link", { p_token: parsed.data.token });
  if (error) {
    if (error.code === "P0002") return c.json({ error: error.message }, 404);
    if (error.code === "42501") return c.json({ error: error.message }, 403);
    console.error("accept_invite_link failed", error);
    return c.json({ error: "failed to join the workspace" }, 500);
  }
  return c.json({ workspaceId: data as string });
});

/**
 * POST /invite-links/preview — what `/invite` shows before anybody signs in.
 * The token travels in the body, never the URL, for `inviteUrl`'s reason.
 */
const inviteLinkPreview = new Hono<AppEnv>();

inviteLinkPreview.post("/invite-links/preview", async (c) => {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "not an invitation" }, 404);

  const { data, error } = await serviceClient(c.env).rpc("invite_link_preview", {
    p_token: parsed.data.token,
  });
  if (error) {
    console.error("could not read an invite link preview", error);
    return c.json({ error: "could not read the invitation" }, 500);
  }
  const row = (
    (data ?? []) as Array<{
      workspace_name: string;
      inviter_name: string | null;
      role: string;
      member_count: number;
      agent_count: number;
      expires_at: string;
      open: boolean;
    }>
  )[0];
  if (!row) return c.json({ error: "not an invitation" }, 404);
  return c.json({
    workspaceName: row.workspace_name,
    inviterName: row.inviter_name ?? null,
    role: row.role,
    memberCount: row.member_count,
    agentCount: row.agent_count,
    expiresAt: Date.parse(row.expires_at),
    open: row.open,
  });
});

export { inviteLinks, inviteLinkPreview };
