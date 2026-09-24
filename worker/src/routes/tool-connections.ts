import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId, memberRole } from "../lib/workspace";
import { encryptSecret } from "../lib/secret-box";
import { mapToolConnection } from "../lib/dto";
import { toolAvailability } from "../lib/harness/registry";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { insertErrorStatus } from "../lib/routines/insert-error";
import { revokeConnectedAccounts } from "../lib/composio/revoke";

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
  /**
   * Two of the four transports, and the omissions are deliberate.
   *
   * `supabase` is created by `POST /supabase-account/projects`, which has a
   * token to check first; `composio` by `POST /composio/connect`, which has a
   * consent flow to start first. Both would arrive here with no credential and
   * be refused by 0062's `tool_connections_credential_shape` anyway — this
   * enum is what turns that into a readable 400 instead of a constraint
   * violation.
   */
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
  const role = await memberRole(db, workspaceId, userId);
  // A viewer reads. `can_write_in_workspace` (0021) says the same thing in
  // SQL and is what the policies on this table use; this is the route saying
  // it in a sentence somebody can read, before it reaches for a client that
  // has no policies at all.
  return Boolean(role) && role !== "viewer";
}

toolConnections.get("/tool-connections", async (c) => {
  const db = c.get("db");
  const { data, error } = await db
    .from("tool_connections")
    .select(
      "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id, toolkit_slug, status, created_by, created_at, updated_at",
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
      "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id, toolkit_slug, status, created_by, created_at, updated_at",
    )
    .maybeSingle();
  if (error) return c.json({ error: "failed to update connection" }, insertErrorStatus(error));
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(mapToolConnection(data));
});

/**
 * Removing a connection — and, when it is a connected application, giving the
 * grant back first.
 *
 * This stayed one endpoint rather than gaining a `DELETE /composio/...` beside
 * it, and that is the point: a second road out would be a second place to
 * forget the revocation, which is exactly the failure this code exists to stop.
 * `lib/composio/revoke.ts` lists all three roads a row can leave by and what
 * runs on each.
 *
 * Order: ask the database whether this caller may remove the row, revoke, then
 * delete. Revoking first would let anyone who can name an id hand back somebody
 * else's grant; deleting first would lose the account id that the revocation
 * needs.
 */
toolConnections.delete("/tool-connections/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  // Through the caller's own client: `tool_connections_read` admits any member
  // and `tool_connections_delete` the creator or an admin, so a row this read
  // does not return is one the delete below would refuse anyway.
  const { data: row } = await db
    .from("tool_connections")
    .select("id, workspace_id, transport")
    .eq("id", id)
    .maybeSingle();

  if (row?.transport === "composio") {
    // The account id is granted to no client role (0062), so this is the
    // service role filling in the column the database withheld — after the
    // read above has already decided the caller may have the row.
    const { data: secretRow } = await serviceClient(c.env)
      .from("tool_connections")
      .select("connected_account_id")
      .eq("id", id)
      .maybeSingle();
    const accountId =
      typeof secretRow?.connected_account_id === "string" ? secretRow.connected_account_id : "";
    // Best effort, and the row goes either way — see `lib/composio/revoke.ts`
    // for why a card that will not disappear is the worse failure.
    if (accountId) await revokeConnectedAccounts(c.env, [accountId]);
  }

  const { error } = await db.from("tool_connections").delete().eq("id", id);
  if (error) return c.json({ error: "failed to remove connection" }, 500);
  return c.body(null, 204);
});

export { toolConnections };
