import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { getActiveWorkspaceId } from "../lib/workspace";

const workspace = new Hono<AppEnv>();

const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

// PATCH /workspace
workspace.patch("/workspace", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = updateWorkspaceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user" }, 404);
  }

  // RLS (workspaces_update_admin) permits only admins to change rows. A non-admin
  // caller matches 0 rows — surface that as 403 instead of a false "saved".
  const { data: updated, error: updateError } = await db
    .from("workspaces")
    .update(parsed.data)
    .eq("id", workspaceId)
    .select("id,name,slug");

  if (updateError) {
    return c.json({ error: "failed to update workspace" }, 500);
  }
  if (!updated || updated.length === 0) {
    return c.json({ error: "only workspace admins can update the workspace" }, 403);
  }

  const row = updated[0];
  return c.json({ id: row.id, name: row.name, slug: row.slug });
});

// GET /workspaces — all workspaces the caller belongs to (for the switcher).
workspace.get("/workspaces", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data: memberships, error: mErr } = await db
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id);
  if (mErr) return c.json({ error: "failed to load memberships" }, 500);

  const ids = (memberships ?? []).map((m) => m.workspace_id as string);
  if (ids.length === 0) return c.json([]);

  const { data: rows, error: wErr } = await db
    .from("workspaces")
    .select("id,name,slug")
    .in("id", ids);
  if (wErr) return c.json({ error: "failed to load workspaces" }, 500);

  const roleById = new Map(
    (memberships ?? []).map((m) => [m.workspace_id as string, m.role as string]),
  );
  const result = (rows ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    slug: w.slug as string,
    role: roleById.get(w.id as string) ?? "member",
  }));
  return c.json(result);
});

// POST /workspaces — create a new workspace; caller becomes admin and it is set
// active. Membership creation requires the create_workspace SECURITY DEFINER RPC
// (workspace_members has no general insert policy).
workspace.post("/workspaces", async (c) => {
  const db = c.get("db");

  const parsed = createWorkspaceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { data, error } = await db.rpc("create_workspace", {
    p_name: parsed.data.name,
  });

  if (error) {
    return c.json({ error: error.message || "failed to create workspace" }, 400);
  }
  return c.json({ id: data as string }, 201);
});

const setActiveSchema = z.object({ workspaceId: z.string().min(1) });

// POST /workspace/active — switch the caller's active workspace.
workspace.post("/workspace/active", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = setActiveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // Only allow switching to a workspace the caller belongs to.
  const { data: membership, error: mErr } = await db
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", parsed.data.workspaceId)
    .maybeSingle();
  if (mErr) return c.json({ error: "failed to verify membership" }, 500);
  if (!membership) return c.json({ error: "not a member of that workspace" }, 403);

  const { error: uErr } = await db
    .from("profiles")
    .update({ active_workspace_id: parsed.data.workspaceId })
    .eq("id", user.id);
  if (uErr) return c.json({ error: "failed to switch workspace" }, 500);

  return c.json({ ok: true });
});

const updateMemberSchema = z.object({ role: z.enum(["admin", "member"]) });

// PATCH /workspace/members/:userId — change a member's role (admin only).
workspace.patch("/workspace/members/:userId", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const targetUserId = c.req.param("userId");

  const parsed = updateMemberSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  // RLS (workspace_members_update_admin) permits only admins; a non-admin
  // matches 0 rows. The last-admin trigger raises on illegal demotions.
  const { data: updated, error } = await db
    .from("workspace_members")
    .update({ role: parsed.data.role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .select("user_id, role");

  if (error) {
    // Trigger violations surface as errors; return a friendly 400.
    return c.json({ error: error.message || "failed to update member" }, 400);
  }
  if (!updated || updated.length === 0) {
    return c.json({ error: "only workspace admins can manage members" }, 403);
  }
  return c.json({ ok: true });
});

// DELETE /workspace/members/:userId — remove a member (admin only).
workspace.delete("/workspace/members/:userId", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const targetUserId = c.req.param("userId");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const { data: deleted, error } = await db
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .select("user_id");

  if (error) {
    return c.json({ error: error.message || "failed to remove member" }, 400);
  }
  if (!deleted || deleted.length === 0) {
    return c.json({ error: "only workspace admins can manage members" }, 403);
  }
  return c.json({ ok: true });
});

export { workspace };
