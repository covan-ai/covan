import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId } from "../lib/workspace";
import { encryptSecret } from "../lib/secret-box";
import { mapToolConnection } from "../lib/dto";
import { toolAvailability } from "../lib/harness/registry";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { insertErrorStatus } from "../lib/routines/insert-error";

/**
 * Connecting a service an agent can call.
 *
 * The screen behind this is deliberately small, because the table behind it is
 * (0059): a label, where it lives, how to authenticate, and which methods a
 * person is willing to allow. Adding HubSpot is filling in this form; it is
 * not a release.
 *
 * Reads go through the caller's own client, so RLS decides. Writes go through
 * the service role, for the reason 0059 gives and `routes/connections.ts`
 * gives before it: the row holds a credential this route encrypts before the
 * database sees it, so there is no INSERT policy to write through — and the
 * permission question is asked first, separately, against `workspace_members`
 * through the caller's client.
 */
const toolConnections = new Hono<AppEnv>();

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The credential, as a person enters it: header names and their values.
 *
 * A map rather than one token because two services in the first week wanted
 * two headers — Supabase behind Kong answers with neither `apikey` nor
 * `Authorization` alone. The whole object is encrypted as one envelope, so a
 * header NAME is as unreadable from PostgREST as its value.
 */
const headersSchema = z.record(z.string().min(1).max(120), z.string().min(1).max(8000));

const createSchema = z.object({
  label: z.string().min(1).max(120),
  transport: z.enum(["http", "sql"]),
  baseUrl: z.string().url(),
  headers: headersSchema,
  allowedMethods: z.array(z.enum(METHODS)).optional(),
  /** For `sql`: the read-only function the connection speaks through. */
  rpc: z.string().min(1).max(120).optional(),
  /** For `http`: what the team wants the agent to know about this API. */
  summary: z.string().max(20_000).optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  allowedMethods: z.array(z.enum(METHODS)).optional(),
  rpc: z.string().min(1).max(120).optional(),
  summary: z.string().max(20_000).optional(),
});

/** Whether this caller may change what agents in this workspace can reach. */
async function mayWrite(
  db: AppEnv["Variables"]["db"],
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  // A viewer reads. `can_write_in_workspace` (0021) says the same thing in
  // SQL and is what the policies on this table use; this is the route saying
  // it in a sentence somebody can read, before it reaches for a client that
  // has no policies at all.
  return Boolean(data) && data?.role !== "viewer";
}

toolConnections.get("/tool-connections", async (c) => {
  const db = c.get("db");
  const { data, error } = await db
    .from("tool_connections")
    .select(
      "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, created_by, created_at, updated_at",
    )
    .order("label", { ascending: true });
  if (error) return c.json({ error: "failed to load connections" }, 500);
  return c.json({
    connections: (data ?? []).map(mapToolConnection),
    // Every tool this build has, and whether this deployment can run it. Not
    // filtered to the configured ones, for the reason `providerAvailability`
    // is not: a self-hoster reading the docs for a feature their own build
    // appears not to have is the failure that pattern exists to avoid.
    tools: toolAvailability(c.env),
  });
});

toolConnections.post("/tool-connections", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  if (!c.env.ROUTINE_SECRET_KEY) {
    return c.json({ error: "this deployment has no ROUTINE_SECRET_KEY set" }, 501);
  }

  const db = c.get("db");
  const userId = c.get("user").id;
  const workspaceId = await getActiveWorkspaceId(db, userId);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  if (!(await mayWrite(db, workspaceId, userId))) {
    return c.json({ error: "read-only in this workspace" }, 403);
  }

  // The same guard every outbound address in this codebase goes through, run
  // here so a connection pointed at `169.254.169.254` is refused while
  // somebody is still looking at the form rather than at run time, where the
  // error reaches a model instead of a person.
  try {
    assertFetchableUrl(body.baseUrl, ownHostsFrom(c.env));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "unusable base URL" }, 400);
  }

  const secret = await encryptSecret(
    JSON.stringify({ headers: body.headers }),
    c.env.ROUTINE_SECRET_KEY,
  );

  const config: Record<string, unknown> = {};
  if (body.transport === "sql") config.rpc = body.rpc?.trim() || "covan_query";
  if (body.summary?.trim()) config.summary = body.summary.trim();

  const { data, error } = await serviceClient(c.env)
    .from("tool_connections")
    .insert({
      workspace_id: workspaceId,
      label: body.label.trim(),
      transport: body.transport,
      // Trailing slash stripped once, here, so `base_url + path` is one rule
      // everywhere downstream rather than a thing each tool re-derives.
      base_url: body.baseUrl.replace(/\/+$/, ""),
      auth_kind: "static_header",
      allowed_methods: body.allowedMethods ?? ["GET"],
      config,
      secret_ciphertext: secret,
      created_by: userId,
    })
    .select("*")
    .single();

  if (error || !data) {
    // A duplicate label in one workspace is the common one and is a bad
    // request rather than a fault: 0059's unique index is case-insensitive,
    // because two connections called "Covan Supabase" and "covan supabase"
    // is a support ticket.
    if (error?.code === "23505") {
      return c.json({ error: "a connection with that name already exists here" }, 400);
    }
    return c.json({ error: "failed to create connection" }, insertErrorStatus(error));
  }
  return c.json(mapToolConnection(data), 201);
});

toolConnections.patch("/tool-connections/:id", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const db = c.get("db");
  // Through the caller's own client: `tool_connections_update` decides, and
  // it admits the connection's creator and a workspace admin. Nothing here
  // re-asks that question, which is the rule this repo holds itself to.
  const { data: current, error: loadError } = await db
    .from("tool_connections")
    .select("id, config")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (loadError) return c.json({ error: "failed to load connection" }, 500);
  if (!current) return c.json({ error: "not found" }, 404);

  const config = { ...((current.config as Record<string, unknown>) ?? {}) };
  if (body.rpc !== undefined) config.rpc = body.rpc.trim();
  if (body.summary !== undefined) config.summary = body.summary.trim();

  const { data, error } = await db
    .from("tool_connections")
    .update({
      ...(body.label !== undefined ? { label: body.label.trim() } : {}),
      ...(body.allowedMethods !== undefined ? { allowed_methods: body.allowedMethods } : {}),
      ...(body.rpc !== undefined || body.summary !== undefined ? { config } : {}),
    })
    .eq("id", c.req.param("id"))
    .select(
      "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, created_by, created_at, updated_at",
    )
    .maybeSingle();
  if (error) return c.json({ error: "failed to update connection" }, insertErrorStatus(error));
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(mapToolConnection(data));
});

toolConnections.delete("/tool-connections/:id", async (c) => {
  const { error } = await c.get("db").from("tool_connections").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: "failed to remove connection" }, 500);
  return c.body(null, 204);
});

export { toolConnections };
