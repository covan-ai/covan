import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId, memberRole } from "../lib/workspace";
import { decryptSecret, encryptSecret } from "../lib/secret-box";
import { hintFor } from "../lib/keys/crypto";
import { mapSupabaseAccount, mapToolConnection } from "../lib/dto";
import { insertErrorStatus } from "../lib/routines/insert-error";
import { listProjects, MANAGEMENT_BASE, type SupabaseProject } from "../lib/supabase-management";

/**
 * Connecting a Supabase account, and the projects it opens.
 *
 * The screen behind this is two fields and a list of checkboxes, which is the
 * whole point: 0059's other road to a Postgres asks a person to install a
 * function in their database first, and this one asks for a token and installs
 * nothing. Both stay.
 *
 * ORDER, BECAUSE IT IS THE SECURITY OF THIS FILE. The permission question is
 * asked BEFORE the token is used for anything, including before it is shown to
 * Supabase. A member who may not connect an account must be told no without
 * their token having been sent to a third party on the way — `POST` below
 * checks the role first and returns 403 before it touches the network.
 *
 * Reads go through the caller's own client, so RLS decides. Writes go through
 * the service role, for the reason 0061 gives: the row holds a credential this
 * route encrypts before the database sees it, so there is no INSERT policy to
 * write through.
 */
const supabaseAccount = new Hono<AppEnv>();

/** Long enough for any real token, short enough to refuse a pasted file. */
const connectSchema = z.object({ token: z.string().trim().min(20).max(500) });

/** One screenful of checkboxes. A workspace with more picks twice. */
const projectsSchema = z.object({
  refs: z.array(z.string().trim().min(1).max(120)).min(1).max(25),
});

/** The columns no client role may select are not among these. */
const ACCOUNT_COLUMNS = "id, workspace_id, token_hint, connected_by, created_at, updated_at";

const CONNECTION_COLUMNS =
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id, created_by, created_at, updated_at";

/** The caller's workspace and their standing in it, in one read. */
async function active(c: Context<AppEnv>) {
  const userId = c.get("user").id;
  const workspaceId = await getActiveWorkspaceId(c.get("db"), userId);
  if (!workspaceId) return { workspaceId: null, role: null, userId };
  return { workspaceId, role: await memberRole(c.get("db"), workspaceId, userId), userId };
}

/**
 * The account row this workspace has, as the caller may see it.
 *
 * Through their own client: `supabase_accounts_read` admits any member, and
 * the column grant is what keeps the token out of the answer.
 */
async function currentAccount(c: Context<AppEnv>, workspaceId: string) {
  const { data } = await c
    .get("db")
    .from("supabase_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * The token behind an account the caller has already been found to be allowed
 * to see.
 *
 * The same two-step `lib/harness/secrets.ts` takes and for the same reason:
 * the permission question was answered by the read above, through a client
 * that has policies, and only then does this reach past the database for the
 * column it withheld. Stored as the header it will be sent as, so one envelope
 * shape serves both this and `authHeaders`; the prefix comes off here because
 * `listProjects` puts it back.
 */
async function tokenFor(c: Context<AppEnv>, accountId: string): Promise<string | null> {
  const { data } = await serviceClient(c.env)
    .from("supabase_accounts")
    .select("token_ciphertext")
    .eq("id", accountId)
    .maybeSingle();
  if (!data) return null;
  try {
    const envelope = JSON.parse(
      await decryptSecret(String(data.token_ciphertext), c.env.ROUTINE_SECRET_KEY),
    ) as { headers?: Record<string, string> };
    const header = envelope.headers?.Authorization ?? "";
    return header.replace(/^Bearer\s+/i, "").trim() || null;
  } catch {
    return null;
  }
}

supabaseAccount.get("/supabase-account", async (c) => {
  const { workspaceId } = await active(c);
  if (!workspaceId) return c.json({ account: null });
  const row = await currentAccount(c, workspaceId);
  return c.json({ account: row ? mapSupabaseAccount(row) : null });
});

supabaseAccount.post("/supabase-account", async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const token = parsed.data.token;

  if (!c.env.ROUTINE_SECRET_KEY) {
    return c.json({ error: "this deployment has no ROUTINE_SECRET_KEY set" }, 501);
  }

  const { workspaceId, role, userId } = await active(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  // Before the network, deliberately. See the note at the top of this file.
  if (role !== "admin") {
    return c.json({ error: "only an admin of this workspace can connect a Supabase account" }, 403);
  }

  const listed = await listProjects(token);
  if (listed.kind === "error") {
    // Supabase's own sentence, forwarded. "that token has expired" is what
    // lets somebody fix it; "could not connect" is not.
    return c.json({ error: listed.message }, 400);
  }

  const { data, error } = await serviceClient(c.env)
    .from("supabase_accounts")
    .upsert(
      {
        workspace_id: workspaceId,
        token_ciphertext: await encryptSecret(
          JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
          c.env.ROUTINE_SECRET_KEY,
        ),
        token_hint: hintFor(token),
        connected_by: userId,
      },
      // One account per workspace (0061). Replacing the token is this same
      // call, which is what makes "change the token" one field rather than a
      // disconnect and a reconnect that would take the projects with it.
      { onConflict: "workspace_id" },
    )
    .select(ACCOUNT_COLUMNS)
    .single();

  if (error || !data) {
    return c.json({ error: "failed to store that token" }, insertErrorStatus(error));
  }

  return c.json(
    { account: mapSupabaseAccount(data as Record<string, unknown>), projects: listed.projects },
    201,
  );
});

supabaseAccount.get("/supabase-account/projects", async (c) => {
  const { workspaceId } = await active(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  const account = await currentAccount(c, workspaceId);
  if (!account) return c.json({ error: "no Supabase account is connected here" }, 400);

  const token = await tokenFor(c, String(account.id));
  if (!token) return c.json({ error: "the stored token could not be read" }, 500);

  const listed = await listProjects(token);
  if (listed.kind === "error") return c.json({ error: listed.message }, 400);
  return c.json({ projects: listed.projects });
});

supabaseAccount.post("/supabase-account/projects", async (c) => {
  const parsed = projectsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { workspaceId, role, userId } = await active(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  // Choosing which projects an agent may read is an ordinary write, not an
  // admin's: by the time there is an account to choose from, an admin has
  // already made the decision that needed making.
  if (!role || role === "viewer") return c.json({ error: "read-only in this workspace" }, 403);

  const account = await currentAccount(c, workspaceId);
  if (!account) return c.json({ error: "no Supabase account is connected here" }, 400);

  const token = await tokenFor(c, String(account.id));
  if (!token) return c.json({ error: "the stored token could not be read" }, 500);

  const listed = await listProjects(token);
  if (listed.kind === "error") return c.json({ error: listed.message }, 400);

  // A ref this account cannot see is refused here rather than stored. The
  // alternative is a connection that looks fine on the page and fails inside
  // an agent's turn, which is the same failure moved somewhere nobody is
  // looking.
  const known = new Map<string, SupabaseProject>(listed.projects.map((p) => [p.ref, p]));
  const wanted = [...new Set(parsed.data.refs)];
  const unknown = wanted.filter((ref) => !known.has(ref));
  if (unknown.length > 0) {
    return c.json({ error: `that account has no project ${unknown[0]}` }, 400);
  }

  const rows = wanted.map((ref) => {
    const project = known.get(ref) as SupabaseProject;
    return {
      workspace_id: workspaceId,
      label: project.name,
      transport: "supabase",
      base_url: MANAGEMENT_BASE,
      auth_kind: "static_header",
      // Meaningless for this transport, as it is for `sql`: one POST to one
      // read-only endpoint. The column's default says GET; saying it here
      // keeps the row readable next to an `http` one.
      allowed_methods: ["GET"],
      config: { ref, projectName: project.name, region: project.region },
      // The token is the account's. 0061's CHECK is what makes this the only
      // shape a supabase row can have.
      secret_ciphertext: null,
      account_id: account.id,
      created_by: userId,
    };
  });

  const { data, error } = await serviceClient(c.env)
    .from("tool_connections")
    .insert(rows)
    .select(CONNECTION_COLUMNS);

  if (error || !data) {
    if (error?.code === "23505") {
      return c.json({ error: "one of those projects is already connected here" }, 400);
    }
    return c.json({ error: "failed to connect those projects" }, insertErrorStatus(error));
  }

  return c.json(
    {
      connections: (data as Array<Parameters<typeof mapToolConnection>[0]>).map(mapToolConnection),
    },
    201,
  );
});

supabaseAccount.delete("/supabase-account", async (c) => {
  const { workspaceId } = await active(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);
  // Through the caller's own client: `supabase_accounts_delete` admits an
  // admin and nobody else, and the cascade on `tool_connections.account_id`
  // takes the projects with it. Nothing here re-asks that question.
  const { error } = await c
    .get("db")
    .from("supabase_accounts")
    .delete()
    .eq("workspace_id", workspaceId);
  if (error) return c.json({ error: "failed to disconnect" }, 500);
  return c.body(null, 204);
});

export { supabaseAccount };
