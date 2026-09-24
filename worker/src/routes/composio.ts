import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId, memberRole } from "../lib/workspace";
import { mapToolConnection, mapToolConnectionGrant } from "../lib/dto";
import { insertErrorStatus } from "../lib/routines/insert-error";
import {
  composioConfigured,
  createLink,
  getConnectedAccount,
  listToolkits,
  COMPOSIO_BASE,
} from "../lib/composio/client";

/**
 * Connecting one of about fifteen hundred applications, and saying what an
 * agent may do with it.
 *
 * WHY THERE IS NO CALLBACK ROUTE HERE, which is the first difference from
 * `routes/connections.ts` anybody will notice. That file holds the OAuth client
 * for Notion and Google, so it has to hold the state too — `oauth-state.ts`, a
 * signed blob, a public callback, a code exchange. Composio holds the client.
 * The consent screen is theirs, the redirect comes back to them, and Covan
 * learns how it went by asking about the account it created. One fewer public
 * endpoint and one fewer signed thing to get wrong.
 *
 * ORDER, BECAUSE IT IS THE SECURITY OF THIS FILE. The permission question is
 * asked before anything is created anywhere. A viewer who may not connect a
 * service is told so before a consent flow exists at Composio to be abandoned.
 *
 * Reads go through the caller's own client, so RLS decides. The one write that
 * does not is the connection insert, for the reason 0059 gives and 0043 gave
 * before it — and one 0062 sharpens: the row carries `connected_account_id`,
 * which no client role may select, so a client that could insert could write
 * another workspace's account id and never read back what it wrote to check.
 * Grants are ordinary writes through the caller's client, where the policies in
 * 0062 decide who may promote one to `always`.
 */
const composio = new Hono<AppEnv>();

/** A toolkit slug as Composio spells it, loosened to what a URL can carry. */
const toolkitPattern = /^[a-z0-9_-]{1,80}$/;

const connectSchema = z.object({
  toolkit: z.string().trim().toLowerCase().regex(toolkitPattern),
  /** What a person wants to call it. Defaults to the toolkit's own name. */
  label: z.string().trim().min(1).max(120).optional(),
});

const grantSchema = z.object({
  agentId: z.string().uuid(),
  connectionId: z.string().uuid(),
  slug: z.string().trim().min(1).max(200),
  mode: z.enum(["ask", "always"]),
});

/** The columns a client may select. `connected_account_id` is not among them. */
const CONNECTION_COLUMNS =
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id, toolkit_slug, status, created_by, created_at, updated_at";

function frontendOrigin(env: Bindings): string {
  return env.ALLOWED_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");
}

/** Whether this caller may change what agents in this workspace can reach. */
async function mayWrite(
  db: AppEnv["Variables"]["db"],
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const role = await memberRole(db, workspaceId, userId);
  // A writer, not an admin — the same bar `tool_connections` itself sets
  // (0059). 0061 asks for an admin and the difference is the blast radius of
  // the credential: a Supabase Management token opens every project in an
  // account somebody else may own, where this is one person completing a
  // consent screen with their own credentials for one application. The second
  // gate is what carries the rest: no agent acts on it without a grant or an
  // approval (0062).
  return Boolean(role) && role !== "viewer";
}

composio.get("/composio/toolkits", async (c) => {
  if (!composioConfigured(c.env)) {
    // Not an error state. The page says which variable would turn this on,
    // exactly as `providerAvailability` does for Notion — a self-hoster reading
    // the docs for a feature their own build appears not to have is the failure
    // that pattern exists to avoid.
    return c.json({ configured: false, toolkits: [] });
  }
  const listed = await listToolkits(c.env, { search: c.req.query("search") ?? undefined });
  if (listed.kind === "error") return c.json({ error: listed.message }, 502);
  // The browser never sees the API key: this route is the proxy that keeps a
  // deployment secret out of a bundle anyone can read.
  return c.json({ configured: true, toolkits: listed.toolkits });
});

composio.post("/composio/connect", async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { toolkit } = parsed.data;

  if (!composioConfigured(c.env)) {
    return c.json({ error: "this deployment has no COMPOSIO_API_KEY set" }, 501);
  }

  const db = c.get("db");
  const userId = c.get("user").id;
  const workspaceId = await getActiveWorkspaceId(db, userId);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  // Before the network, deliberately. A refused caller must not leave a
  // half-made consent flow behind them at a third party.
  if (!(await mayWrite(db, workspaceId, userId))) {
    return c.json({ error: "read-only in this workspace" }, 403);
  }

  // The identity Composio executes on behalf of, chosen here and stored on the
  // row. Deliberately not `userId`: a Covan account uuid shipped to a third
  // party as a durable identifier is a thing this codebase does not do, and it
  // would be the wrong value anyway — the same connection is used by a chat
  // turn and by a 3am routine, which resolve to different people.
  const composioUserId = crypto.randomUUID();

  const link = await createLink(c.env, {
    toolkit,
    userId: composioUserId,
    // Where the person lands after the consent screen. The page reads the
    // query parameter, says one sentence and takes it out of the address bar —
    // `useGrantOutcome` in `_authed.integrations.tsx` already does exactly this
    // for Notion and Drive.
    callbackUrl: `${frontendOrigin(c.env)}/integrations?connected=${encodeURIComponent(toolkit)}`,
  });
  if (link.kind === "error") return c.json({ error: link.message }, 502);

  const { data, error } = await serviceClient(c.env)
    .from("tool_connections")
    .insert({
      workspace_id: workspaceId,
      label: parsed.data.label ?? toolkit,
      transport: "composio",
      // No per-row address on this transport, and the column is NOT NULL. 0062's
      // banner argues the duplication rather than widening the check.
      base_url: (c.env.COMPOSIO_BASE_URL || COMPOSIO_BASE).replace(/\/+$/, ""),
      auth_kind: "composio",
      // Meaningless here, as it is for `sql` and `supabase`: the method is
      // Composio's business. Said explicitly so the row reads sensibly.
      allowed_methods: ["GET"],
      config: {},
      secret_ciphertext: null,
      account_id: null,
      toolkit_slug: toolkit,
      connected_account_id: link.connectedAccountId,
      composio_user_id: composioUserId,
      // A row exists from the moment somebody is sent to a consent screen, so
      // there is something to poll and something to clean up if they walk away.
      // `listConnections` hides it from the model until it is active.
      status: "pending",
      created_by: userId,
    })
    .select(CONNECTION_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return c.json({ error: "a connection with that name already exists here" }, 400);
    }
    return c.json({ error: "failed to start that connection" }, insertErrorStatus(error));
  }

  // A URL rather than a 302, for the reason `connections.ts` gives: the caller
  // is a `fetch` from the application, which cannot follow a cross-origin
  // redirect to a consent screen — a 302 here is a CORS error, not a login page.
  return c.json({ url: link.redirectUrl, connection: mapToolConnection(data as never) }, 201);
});

/**
 * How a consent flow ended.
 *
 * Polled by the page while somebody is away at the provider. It is a read of
 * the caller's own row first — RLS decides whether they may see it — and only
 * then a question to Composio about the account that row names.
 */
composio.get("/composio/connections/:id/status", async (c) => {
  const db = c.get("db");
  const { data: row, error } = await db
    .from("tool_connections")
    .select("id, workspace_id, transport, status")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load that connection" }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.transport !== "composio") return c.json({ error: "not a connected application" }, 400);
  // Settled already. Asking Composio again would be a request per poll for an
  // answer that cannot change.
  if (row.status !== "pending") return c.json({ status: row.status });

  if (!composioConfigured(c.env)) {
    return c.json({ error: "this deployment has no COMPOSIO_API_KEY set" }, 501);
  }

  // The account id is readable by no client role (0062), so this is the service
  // role filling in the column the database withheld — after the read above has
  // already decided the caller may have the row. `lib/harness/secrets.ts`'s
  // order, in a route.
  const admin = serviceClient(c.env);
  const { data: secretRow } = await admin
    .from("tool_connections")
    .select("connected_account_id")
    .eq("id", row.id)
    .maybeSingle();
  const accountId =
    typeof secretRow?.connected_account_id === "string" ? secretRow.connected_account_id : "";
  if (!accountId) return c.json({ status: "failed" });

  const asked = await getConnectedAccount(c.env, accountId);
  if (asked.kind === "error") return c.json({ status: "pending" });
  if (asked.status === "pending") return c.json({ status: "pending" });

  // Through the service role because `status` is granted to `authenticated` for
  // reading only — the settings screen edits a label, not the state of somebody
  // else's consent flow.
  const { error: updateError } = await admin
    .from("tool_connections")
    .update({ status: asked.status })
    .eq("id", row.id);
  if (updateError) console.error("could not settle a connection's status", updateError);
  return c.json({ status: asked.status });
});

/**
 * What one agent may do at one connected service.
 *
 * Every read and write below goes through the caller's own client, and that is
 * the whole access control: 0062's policies admit a member to read, a writer to
 * create an `ask` or to remove anything, and an admin alone to promote to
 * `always`. Nothing here re-asks that question, which is the rule this
 * repository holds itself to.
 */
composio.get("/composio/grants", async (c) => {
  const agentId = c.req.query("agentId");
  let query = c
    .get("db")
    .from("tool_connection_grants")
    .select("agent_id, tool_connection_id, slug, mode, granted_by, granted_at");
  if (agentId) query = query.eq("agent_id", agentId);
  const { data, error } = await query;
  if (error) return c.json({ error: "failed to load grants" }, 500);
  return c.json({ grants: (data ?? []).map(mapToolConnectionGrant) });
});

composio.put("/composio/grants", async (c) => {
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const db = c.get("db");
  const workspaceId = await getActiveWorkspaceId(db, c.get("user").id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  // `workspace_id` is denormalised and constrained to agree with both parents
  // (0062), so a value that does not match the agent's or the connection's is
  // refused by the foreign keys rather than by anything here. Sent because the
  // column is NOT NULL, not because it is trusted.
  const { data, error } = await db
    .from("tool_connection_grants")
    .upsert(
      {
        agent_id: body.agentId,
        tool_connection_id: body.connectionId,
        workspace_id: workspaceId,
        slug: body.slug,
        mode: body.mode,
      },
      { onConflict: "agent_id,tool_connection_id,slug" },
    )
    .select("agent_id, tool_connection_id, slug, mode, granted_by, granted_at")
    .single();

  if (error || !data) {
    // A writer who is not an admin trying to promote to `always` lands here:
    // the insert policy's WITH CHECK refuses it, which PostgREST reports as a
    // permission error. Said in the sentence a person needs rather than as a
    // policy name.
    return c.json(
      {
        error:
          body.mode === "always"
            ? "only an admin of this workspace can let an agent do this without asking"
            : "failed to save that permission",
      },
      insertErrorStatus(error),
    );
  }
  return c.json(mapToolConnectionGrant(data));
});

composio.delete("/composio/grants", async (c) => {
  const agentId = c.req.query("agentId");
  const connectionId = c.req.query("connectionId");
  const slug = c.req.query("slug");
  if (!agentId || !connectionId || !slug) {
    return c.json({ error: "agentId, connectionId and slug are required" }, 400);
  }
  // Revoking is a writer's, and it is deliberately not an admin's: taking a
  // standing permission away can never be the unsafe direction (0062).
  const { error } = await c
    .get("db")
    .from("tool_connection_grants")
    .delete()
    .eq("agent_id", agentId)
    .eq("tool_connection_id", connectionId)
    .eq("slug", slug);
  if (error) return c.json({ error: "failed to remove that permission" }, 500);
  return c.body(null, 204);
});

export { composio };
