import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { toEpochMs } from "../lib/dto";
import type { PendingInvitationDTO, IncomingInvitationDTO } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";

const invitations = new Hono<AppEnv>();

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

// GET /invitations — pending invites for the caller's active workspace (admin).
invitations.get("/invitations", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  // RLS returns rows only to admins of the workspace (or invitees by email);
  // scoping to workspace + pending keeps this to the admin's pending list.
  const { data, error } = await db
    .from("invitations")
    .select("id, email, role, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load invitations" }, 500);

  const result: PendingInvitationDTO[] = (data ?? []).map((r) => ({
    id: r.id as string,
    email: r.email as string,
    role: r.role as string,
    createdAt: toEpochMs(r.created_at as string),
  }));
  return c.json(result);
});

// POST /invitations — create an invite (admin only, enforced by RLS insert policy).
invitations.post("/invitations", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = createInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const email = parsed.data.email.trim().toLowerCase();

  const { data, error } = await db
    .from("invitations")
    .insert({
      workspace_id: workspaceId,
      email,
      role: parsed.data.role,
      invited_by: user.id,
    })
    .select("id, email, role, created_at");

  if (error) {
    // Unique-pending index violation → already invited.
    if (error.code === "23505") {
      return c.json({ error: "that email already has a pending invitation" }, 409);
    }
    // RLS insert check failure surfaces as an error → treat as forbidden.
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }

  const row = data[0];
  const result: PendingInvitationDTO = {
    id: row.id as string,
    email: row.email as string,
    role: row.role as string,
    createdAt: toEpochMs(row.created_at as string),
  };
  return c.json(result, 201);
});

// DELETE /invitations/:id — revoke a pending invite (admin only).
invitations.delete("/invitations/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data, error } = await db.from("invitations").delete().eq("id", id).select("id");

  if (error) return c.json({ error: "failed to revoke invitation" }, 500);
  if (!data || data.length === 0) {
    return c.json({ error: "invitation not found or not permitted" }, 404);
  }
  return c.json({ ok: true });
});

// GET /invitations/incoming — pending invites addressed to the caller's email.
invitations.get("/invitations/incoming", async (c) => {
  const db = c.get("db");

  // RLS select policy already limits rows to invites whose email == caller's JWT
  // email (or workspaces they admin); filter to pending and join the name.
  const { data, error } = await db
    .from("invitations")
    .select("id, workspace_id, role, created_at, workspaces(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load invitations" }, 500);

  const result: IncomingInvitationDTO[] = (data ?? []).map((r) => {
    const ws = r.workspaces as { name: string } | { name: string }[] | null;
    const name = Array.isArray(ws) ? (ws[0]?.name ?? "") : (ws?.name ?? "");
    return {
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      workspaceName: name,
      role: r.role as string,
      createdAt: toEpochMs(r.created_at as string),
    };
  });
  return c.json(result);
});

// POST /invitations/:id/accept — accept via SECURITY DEFINER RPC.
invitations.post("/invitations/:id/accept", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data, error } = await db.rpc("accept_invitation", { p_invite_id: id });

  if (error) {
    return c.json({ error: error.message || "failed to accept invitation" }, 400);
  }
  return c.json({ workspaceId: data as string });
});

export { invitations };
