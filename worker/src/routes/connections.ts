import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId } from "../lib/workspace";
import { mapConnection, mapConnectionRun } from "../lib/dto";
import { encryptSecret, decryptSecret } from "../lib/secret-box";
import { providerFor, providerAvailability } from "../lib/connections/registry";
import { readState, signState } from "../lib/connections/oauth-state";
import { runOneConnection } from "../lib/connections/dispatcher";
import { listFolders } from "../lib/connections/google-drive";
import { ProviderError, type TokenEnvelope } from "../lib/connections/types";
import type { ConnectionRow } from "../lib/connections/sync";

/**
 * Connections: the two halves of a connector that a person actually touches.
 *
 * Everything here is either a step in an OAuth flow or an answer to "is it
 * working?". The syncing itself happens in `lib/connections`, on a cron, and
 * nothing in this file imports a provider's API.
 *
 * One route is deliberately outside the authenticated router, and it is the
 * only one: `GET /connections/callback`. A browser arriving on a redirect from
 * Notion or Google carries no bearer token, so who this grant belongs to has to
 * travel in the `state` parameter — see `lib/connections/oauth-state.ts` for why
 * that is encrypted rather than random, and what it is careful not to be.
 */

const connections = new Hono<AppEnv>();

/** Unauthenticated by necessity — mounted on the root app, not on `api`. */
const connectionsPublic = new Hono<AppEnv>();

const CONNECTION_SELECT =
  "id,provider,account_label,bundle_id,user_id,status,paused_reason,paused_code,config," +
  "sync_interval_minutes,next_sync_at,last_sync_at,created_at," +
  "knowledge_bundles(name),documents(count)";

/**
 * Where the browser is sent back to after a grant.
 *
 * The first entry of ALLOWED_ORIGIN, which is the same choice the CORS
 * middleware makes for an unrecognised origin — and it has to be a fixed value
 * rather than anything from the request, because a redirect target taken from a
 * query parameter is an open redirect with extra steps.
 */
function frontendOrigin(env: Bindings): string {
  return env.ALLOWED_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");
}

/**
 * The redirect URI, which both ends of the flow have to agree on exactly.
 *
 * Providers compare it byte for byte against the one registered in their
 * console and again between the authorize and token calls, so it is derived
 * once, here. `WORKER_HOST` wins when it is set: behind a custom domain the
 * request URL a Worker sees is the right one, but saying so explicitly is what
 * makes a proxy in front of this a configuration rather than a mystery.
 */
function redirectUri(c: { env: Bindings; req: { url: string } }): string {
  const base = c.env.WORKER_HOST
    ? `https://${c.env.WORKER_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
    : new URL(c.req.url).origin;
  return `${base}/connections/callback`;
}

// GET /connections — what is connected, and what could be.
//
// Both halves in one response on purpose: a page that lists connections and a
// page that offers providers are the same page, and two requests would let them
// disagree about whether Notion is configured.
connections.get("/connections", async (c) => {
  const db = c.get("db");

  // Scoped to the active workspace, not left to RLS alone. A person can be a
  // member of two workspaces, and the policy is written from the workspace's
  // point of view — so an unscoped read would put another team's connections on
  // this team's page, all of them legitimately visible and none of them theirs.
  const workspaceId = await getActiveWorkspaceId(db, c.get("user").id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const { data, error } = await db
    .from("connections")
    .select(CONNECTION_SELECT)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: "failed to load connections" }, 500);

  return c.json({
    connections: (data ?? []).map((row) =>
      mapConnection(row as unknown as Parameters<typeof mapConnection>[0]),
    ),
    providers: providerAvailability(c.env),
  });
});

// GET /connections/:id/runs — the last few syncs, newest first.
connections.get("/connections/:id/runs", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("connection_runs")
    .select(
      "id,status,documents_added,documents_updated,documents_removed,error,duration_ms,started_at",
    )
    .eq("connection_id", c.req.param("id"))
    .order("started_at", { ascending: false })
    .limit(10);
  if (error) return c.json({ error: "failed to load runs" }, 500);
  return c.json((data ?? []).map(mapConnectionRun));
});

const startSchema = z.object({ bundleId: z.string().min(1) });

// POST /connections/:provider/start — begin a grant.
//
// Returns a URL rather than redirecting: the caller is a `fetch` from the
// application, which cannot follow a cross-origin redirect to a consent screen,
// and turning that into a 302 here would produce a CORS error instead of a
// login page.
connections.post("/connections/:provider/start", async (c) => {
  const provider = providerFor(c.req.param("provider"));
  if (!provider) return c.json({ error: "unknown provider" }, 404);
  if (!provider.isConfigured(c.env)) {
    return c.json({ error: `${provider.label} is not configured on this deployment` }, 501);
  }

  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  // Read through the caller's own client, so a bundle in another workspace —
  // or one they may not see — is simply not found. The state that comes out of
  // this is therefore only ever a bundle they were already allowed to write to.
  const { data: bundle, error } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", parsed.data.bundleId)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle || bundle.workspace_id !== workspaceId) return c.json({ error: "not found" }, 404);

  const state = await signState(
    {
      provider: provider.id,
      userId: user.id,
      workspaceId,
      bundleId: bundle.id,
    },
    c.env.ROUTINE_SECRET_KEY,
  );

  return c.json({ url: provider.authorizeUrl(c.env, state, redirectUri(c)) });
});

/**
 * POST /connections/:id/reconnect — a new grant for a connection that has one.
 *
 * The same OAuth flow as Connect, pointed at a row that already exists. It is
 * a separate route rather than a flag on `start` because the two answer
 * different questions — Connect asks which bundle, Reconnect asks which
 * connection — and folding them together would mean one handler where half the
 * inputs are ignored depending on the other half.
 *
 * WHY IT EXISTS AT ALL. Without it, the way to fix a revoked Google grant was
 * to delete the connection and connect again, which produced a SECOND
 * connection pointed at the same bundle, left the first one sitting there
 * paused, and relied on `adoptOrphans` to re-attach documents whose
 * `connection_id` the delete had nulled. Every part of that worked and the
 * result was a page with two rows for one Drive folder and no way to tell which
 * one mattered.
 *
 * WHO MAY. `loadForCaller` proves they can see it; the write below is made
 * through the caller's own client, so 0057's policy decides — the grant holder,
 * an admin, or any writing member when the row is unowned. A viewer gets
 * nothing back and a 403.
 */
connections.post("/connections/:id/reconnect", async (c) => {
  const loaded = await loadForCaller(c, c.req.param("id"));
  if ("response" in loaded) return loaded.response;
  const { connection, provider } = loaded;

  if (!provider.isConfigured(c.env)) {
    return c.json({ error: `${provider.label} is not configured on this deployment` }, 501);
  }

  // The permission question, asked of the database by making the smallest
  // change there is — the same trick `POST /connections/:id/sync` uses, and for
  // the same reason: seeing a connection is membership, replacing its
  // credential is writing, and nothing downstream of here consults RLS again.
  const { data: allowed, error: allowedError } = await c
    .get("db")
    .from("connections")
    .update({ status: connection.status })
    .eq("id", connection.id)
    .select("id")
    .maybeSingle();
  if (allowedError) return c.json({ error: "failed to load connection" }, 500);
  if (!allowed) {
    return c.json({ error: "you do not have permission to reconnect this connection" }, 403);
  }

  const state = await signState(
    {
      provider: provider.id,
      userId: c.get("user").id,
      workspaceId: connection.workspace_id,
      bundleId: connection.bundle_id,
      connectionId: connection.id,
    },
    c.env.ROUTINE_SECRET_KEY,
  );

  return c.json({ url: provider.authorizeUrl(c.env, state, redirectUri(c)) });
});

/**
 * GET /connections/callback — the other end of the grant.
 *
 * Unauthenticated, and everything it trusts comes out of `state`, which only
 * decrypts if we issued it. Every claim inside is then re-checked against the
 * database before a row is written: that the person is still a member of that
 * workspace, that they are allowed to write in it, and that the bundle is still
 * in it. A state is ten minutes long, and all three can change inside it.
 *
 * The response is always a redirect back to the application, never JSON. The
 * audience is a browser that has just come from a consent screen, and the
 * failure it must not be shown is a bare 400.
 */
connectionsPublic.get("/connections/callback", async (c) => {
  const home = `${frontendOrigin(c.env)}/integrations`;
  const fail = (reason: string) => c.redirect(`${home}?error=${encodeURIComponent(reason)}`, 302);

  const url = new URL(c.req.url);
  const error = url.searchParams.get("error");
  if (error) {
    // The person pressed Cancel on the consent screen, most of the time.
    return fail(error === "access_denied" ? "cancelled" : error);
  }

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState) return fail("missing_code");

  const state = await readState(rawState, c.env.ROUTINE_SECRET_KEY);
  if (!state) return fail("expired");

  const provider = providerFor(state.provider);
  if (!provider || !provider.isConfigured(c.env)) return fail("unavailable");

  // Service role from here on, for the reason `POST /delivery-channels` uses
  // it: `connections` has no INSERT grant, because the row holds a secret this
  // route has to encrypt before the database ever sees it. There is also no
  // caller for RLS to resolve — that is what the three checks below stand in
  // for, and none of them is skippable.
  const admin = serviceClient(c.env);

  const { data: membership } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.userId)
    .maybeSingle();
  if (!membership) return fail("not_a_member");
  if (membership.role === "viewer") return fail("read_only");

  const { data: bundle } = await admin
    .from("knowledge_bundles")
    .select("id")
    .eq("id", state.bundleId)
    .eq("workspace_id", state.workspaceId)
    .maybeSingle();
  if (!bundle) return fail("bundle_gone");

  let exchanged;
  try {
    exchanged = await provider.exchangeCode(c.env, code, redirectUri(c), fetch.bind(globalThis));
  } catch (err) {
    console.error("oauth exchange failed", state.provider, err);
    return fail(err instanceof ProviderError ? "grant_failed" : "exchange_failed");
  }

  const secret = await encryptSecret(JSON.stringify(exchanged.token), c.env.ROUTINE_SECRET_KEY);

  // Replacing a grant, not making one. The id came out of the state this
  // deployment issued to this person for this workspace, and it is matched
  // against that workspace again here — so a state whose connection has since
  // been deleted, or moved, writes nothing rather than writing somewhere else.
  if (state.connectionId) {
    const { data } = await admin
      .from("connections")
      .select("id,provider,config")
      .eq("id", state.connectionId)
      .eq("workspace_id", state.workspaceId)
      .maybeSingle();
    // Named rather than inferred: this client carries no generated schema, so
    // postgrest-js widens a multi-column select to a union it cannot narrow.
    const existing = data as { id: string; provider: string; config: unknown } | null;
    if (!existing) return fail("connection_gone");
    // The provider is fixed at creation. A Notion grant arriving for a Drive
    // connection would mean a state issued for one row was completed against
    // another, and the safe answer to something that should be impossible is
    // to refuse it rather than to write it.
    if (existing.provider !== provider.id) return fail("wrong_provider");

    // A Drive reconnect keeps the folder that was already chosen. It is the
    // whole reason this is an update: the person is replacing a credential,
    // not setting the connection up again, and asking them to find the folder
    // a second time would be asking them to state the same intention twice.
    // A folder the new grant cannot see surfaces as a listing that has lost
    // documents, which is exactly what `access_narrowed` is for.
    const keptConfig = {
      ...(exchanged.config ?? {}),
      ...((existing.config as Record<string, unknown> | null) ?? {}),
    };
    const stillNeedsFolder =
      provider.id === "google_drive" &&
      typeof (keptConfig as { folderId?: unknown }).folderId !== "string";

    const { error: updateError } = await admin
      .from("connections")
      .update({
        // The new grant holder, which is the point of the whole route: whoever
        // just granted access is whose view the sync now has and whose
        // allowance it now spends.
        user_id: state.userId,
        account_label: exchanged.accountLabel,
        config: keptConfig,
        secret_ciphertext: secret,
        status: stillNeedsFolder ? "paused" : "active",
        paused_reason: null,
        paused_code: stillNeedsFolder ? "needs_folder" : null,
        consecutive_failures: 0,
        next_sync_at: new Date().toISOString(),
        // Deliberately NOT cleared, and deliberately not set. A reconnect is
        // the single most likely cause of a narrowing, so the next run has to
        // be free to notice one — an approval carried over from a previous
        // pause would let the new grant's smaller view delete the difference
        // without asking.
        removals_approved_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (updateError) {
      console.error("failed to reconnect connection", updateError);
      return fail("save_failed");
    }

    return c.redirect(`${home}?reconnected=${provider.id}&connection=${existing.id}`, 302);
  }

  // A Drive connection has no folder yet and must not sync until it has one.
  // Notion's scope came from Notion's own picker, so it is ready immediately.
  const needsFolder = provider.id === "google_drive";

  const { data: row, error: insertError } = await admin
    .from("connections")
    .insert({
      workspace_id: state.workspaceId,
      bundle_id: state.bundleId,
      user_id: state.userId,
      provider: provider.id,
      account_label: exchanged.accountLabel,
      config: exchanged.config,
      secret_ciphertext: secret,
      status: needsFolder ? "paused" : "active",
      paused_reason: null,
      paused_code: needsFolder ? "needs_folder" : null,
    })
    .select("id")
    .single();
  if (insertError || !row) {
    console.error("failed to save connection", insertError);
    return fail("save_failed");
  }

  return c.redirect(`${home}?connected=${provider.id}&connection=${row.id}`, 302);
});

// GET /connections/:id/folders — browse Drive, one level at a time.
//
// The browser cannot ask Drive itself: it does not have the token, and giving
// it one so it could would undo the entire reason the token is encrypted in a
// column no client can select.
connections.get("/connections/:id/folders", async (c) => {
  const loaded = await loadForCaller(c, c.req.param("id"));
  if ("response" in loaded) return loaded.response;
  const { connection, provider } = loaded;

  if (provider.id !== "google_drive") {
    return c.json({ error: "this connection has no folders to choose from" }, 400);
  }

  const parent = c.req.query("parent") || "root";
  try {
    const token = await tokenFor(c.env, connection, provider);
    const folders = await listFolders(
      { token, config: connection.config ?? {}, fetchImpl: fetch.bind(globalThis) },
      parent,
    );
    return c.json(folders);
  } catch (err) {
    console.error("drive folder listing failed", err);
    return c.json(
      { error: err instanceof ProviderError ? err.message : "could not read your Drive" },
      502,
    );
  }
});

const patchSchema = z
  .object({
    status: z.enum(["active", "paused"]).optional(),
    syncIntervalMinutes: z.number().int().min(15).max(10080).optional(),
    folderId: z.string().min(1).optional(),
    folderName: z.string().min(1).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field required" });

// PATCH /connections/:id — choose a folder, change the cadence, pause, resume.
connections.patch("/connections/:id", async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const loaded = await loadForCaller(c, c.req.param("id"));
  if ("response" in loaded) return loaded.response;
  const { connection } = loaded;

  // Choosing a folder is what finishes setting up a Drive connection, so it also
  // starts it — asking somebody to pick a folder and then press Resume would be
  // asking them to complete the same intention twice.
  const resuming = body.status === "active" || Boolean(body.folderId);

  // The write is split in two, and the split is the permission check.
  //
  // 0043 grants `authenticated` UPDATE on exactly three columns: status,
  // paused_reason and sync_interval_minutes. Everything else a change implies —
  // the chosen folder, the failure counter, when to sync next — is the engine's
  // bookkeeping, and granting it would let a client set `next_sync_at` in a loop
  // or repoint `config` at a folder the owner never picked.
  //
  // So the caller's own client writes the granted columns first, and whether a
  // row comes back IS the answer to "may this person change this connection" —
  // asked of the policy, in the database, rather than re-derived here. `status`
  // is always included so there is a granted column to write even when the only
  // thing being changed is a folder.
  const granted: Record<string, unknown> = {
    status: body.status ?? (body.folderId ? "active" : connection.status),
  };
  if (body.syncIntervalMinutes) granted.sync_interval_minutes = body.syncIntervalMinutes;

  const { data: allowed, error: grantedError } = await c
    .get("db")
    .from("connections")
    .update(granted)
    .eq("id", connection.id)
    .select("id")
    .maybeSingle();
  if (grantedError) return c.json({ error: "failed to update connection" }, 500);
  if (!allowed) {
    return c.json({ error: "you do not have permission to change this connection" }, 403);
  }

  // Only now, and only for the columns no client may write. The row this
  // touches is the one the policy just let through.
  const bookkeeping: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.folderId) {
    bookkeeping.config = {
      ...(connection.config ?? {}),
      folderId: body.folderId,
      folderName: body.folderName ?? body.folderId,
    };
  }
  if (resuming) {
    bookkeeping.consecutive_failures = 0;
    bookkeeping.next_sync_at = new Date().toISOString();
    // Resuming clears the reason the engine paused it, and the code beside it.
    // Leaving either would have the interface explain a state the connection is
    // no longer in.
    //
    // Both are written here rather than in the granted half above, and that
    // moved in 0057: `update (paused_reason)` used to be granted to
    // `authenticated` for exactly this clear, which also let any member who can
    // write put an arbitrary sentence in a column the interface prints. The
    // grant is gone; the need is met by the service role, on a row the policy
    // has just admitted this caller to.
    bookkeeping.paused_reason = null;
    bookkeeping.paused_code = null;

    // Resuming from THIS pause is not "start again", it is "yes, really remove
    // those". The run that paused counted the documents the source has stopped
    // showing and removed none of them; without a recorded decision the next
    // run would count the same documents and pause again, forever.
    //
    // Recorded here and not writable by a client, because the thing that makes
    // it safe is that the API checked which pause it is answering.
    if (connection.paused_code === "access_narrowed") {
      bookkeeping.removals_approved_at = new Date().toISOString();
    }
  }

  const { data, error } = await serviceClient(c.env)
    .from("connections")
    .update(bookkeeping)
    .eq("id", connection.id)
    .select(CONNECTION_SELECT)
    .maybeSingle();
  if (error || !data) return c.json({ error: "failed to update connection" }, 500);

  return c.json(mapConnection(data as unknown as Parameters<typeof mapConnection>[0]));
});

// POST /connections/:id/sync — run it now.
//
// Bounded by the same MAX_DOCUMENTS_PER_RUN as a scheduled run, so this is
// "make progress now" rather than "import everything now" — a folder of two
// hundred files takes the same number of runs either way, and the reply says
// whether there is more.
connections.post("/connections/:id/sync", async (c) => {
  const loaded = await loadForCaller(c, c.req.param("id"));
  if ("response" in loaded) return loaded.response;
  const { connection } = loaded;

  if (connection.status === "paused") {
    return c.json({ error: "this connection is paused" }, 409);
  }

  // Asking the database whether this caller may change this connection, by
  // making the smallest change there is: writing `status` back to the value it
  // already holds. `loadForCaller` only proved they can SEE it, and a viewer can
  // see everything — a sync writes documents into the workspace and spends the
  // owner's allowance, so seeing is not enough. The sync itself runs as the
  // service role and RLS will not be consulted again, which is exactly why the
  // question has to be asked here.
  const { data: allowed } = await c
    .get("db")
    .from("connections")
    .update({ status: connection.status })
    .eq("id", connection.id)
    .select("id")
    .maybeSingle();
  if (!allowed) {
    return c.json({ error: "you do not have permission to sync this connection" }, 403);
  }

  const outcome = await runOneConnection(c.env, await withSecret(c.env, connection));
  return c.json(outcome);
});

const DELETE_MODES = new Set(["keep", "delete"]);

// DELETE /connections/:id — stop syncing, and decide what happens to the copies.
//
// `?documents=keep` is the default, and the schema agrees with it:
// `documents.connection_id` is `on delete set null`, so the rows survive on
// their own. Disconnecting a source is not a request to unlearn what it taught,
// and the team that connected Drive in March should not lose its handbook
// because somebody tidied up in September.
connections.delete("/connections/:id", async (c) => {
  const mode = c.req.query("documents") ?? "keep";
  if (!DELETE_MODES.has(mode)) return c.json({ error: "documents must be keep or delete" }, 400);

  const db = c.get("db");
  const id = c.req.param("id");

  const { data: existing, error: readError } = await db
    .from("connections")
    .select("id,bundle_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) return c.json({ error: "failed to load connection" }, 500);
  if (!existing) return c.json({ error: "not found" }, 404);

  // Documents first, while `connection_id` still points at anything. After the
  // connection row is gone the foreign key has nulled it, and there is no query
  // left that can tell a synced document from an uploaded one.
  let removed = 0;
  if (mode === "delete") {
    const { data: docs, error: docsError } = await db
      .from("documents")
      .select("id")
      .eq("connection_id", id);
    if (docsError) return c.json({ error: "failed to load this connection's documents" }, 500);

    const ids = (docs ?? []).map((d) => d.id);
    if (ids.length > 0) {
      // Marked, not deleted — the same answer 0040 gave the rest of the
      // product. "Also delete the documents" is a real request and this is the
      // real thing, with the thirty days everything else gets: the rows leave
      // every screen at once, and `runPurge` takes them and their objects
      // together when the time is up.
      //
      // One statement rather than `soft_delete_document` per row, because a
      // connection can own hundreds and a Worker has fifty subrequests. The
      // permission question is not skipped by that — `documents_update_member`
      // asks `can_write_in_workspace`, so a viewer moves no rows and the count
      // below is what says so.
      const { data: hidden, error: hideError } = await db
        .from("documents")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by: c.get("user").id,
          // Hidden on their own, so restoring the bundle does not bring them
          // back. Somebody asked for these to go with the connection.
          deleted_via: null,
        })
        .in("id", ids)
        .select("id");
      if (hideError) return c.json({ error: "failed to delete documents" }, 500);
      // RLS refusing here is the viewer case, and it has to be visible: the
      // alternative is a caller who asked for the documents to go, was told
      // "ok", and still has them.
      if ((hidden ?? []).length < ids.length) {
        return c.json({ error: "you do not have permission to delete these documents" }, 403);
      }
      removed = (hidden ?? []).length;
    }
  }

  const { data: deleted, error } = await db.from("connections").delete().eq("id", id).select("id");
  if (error) return c.json({ error: "failed to disconnect" }, 500);
  if (!deleted || deleted.length === 0) {
    return c.json({ error: "you do not have permission to remove this connection" }, 403);
  }

  return c.json({ ok: true, documentsRemoved: removed });
});

/**
 * Load a connection the caller can see, with its provider.
 *
 * The read goes through the caller's own client, so RLS answers "is this yours
 * to look at" — but the row it returns has no `secret_ciphertext` in it, since
 * no client may select that column. Anything that needs the token re-reads it
 * with the service role through `tokenFor`, which is the narrowest place that
 * can be.
 */
async function loadForCaller(
  c: Context<AppEnv>,
  id: string,
): Promise<
  | { response: Response }
  | { connection: ConnectionRow; provider: NonNullable<ReturnType<typeof providerFor>> }
> {
  const { data, error } = await c
    .get("db")
    .from("connections")
    // One string literal, not a concatenation: postgrest-js reads this as a
    // literal type to work out the row shape, and `a + b` widens it to `string`
    // and takes the inference with it.
    // prettier-ignore
    .select(
      "id,workspace_id,bundle_id,user_id,provider,account_label,config,status,paused_code,sync_interval_minutes,consecutive_failures",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) return { response: c.json({ error: "failed to load connection" }, 500) };
  if (!data) return { response: c.json({ error: "not found" }, 404) };

  const provider = providerFor(data.provider as string);
  if (!provider) return { response: c.json({ error: "unknown provider" }, 500) };

  return {
    // `secret_ciphertext` is absent by design and filled in only where it is
    // needed, so this is not quite a ConnectionRow until `tokenFor` runs.
    connection: { ...(data as object), secret_ciphertext: "" } as ConnectionRow,
    provider,
  };
}

/**
 * The same row, with the one column a client may not select.
 *
 * `loadForCaller` reads through RLS and therefore cannot see
 * `secret_ciphertext` — 0043 withholds it from `authenticated` on purpose. So
 * the permission question is answered first, by the database, and only then is
 * the credential fetched, by id, with the service role. The order is the point:
 * this function never decides anything, it only fills in a column for a row
 * somebody has already been found to be allowed to have.
 */
async function withSecret(env: Bindings, connection: ConnectionRow): Promise<ConnectionRow> {
  const { data, error } = await serviceClient(env)
    .from("connections")
    .select("secret_ciphertext")
    .eq("id", connection.id)
    .maybeSingle();
  if (error || !data) throw new ProviderError("this connection has no stored credential", false);
  return { ...connection, secret_ciphertext: data.secret_ciphertext as string };
}

/** The live access token for one connection, refreshed if it was about to expire. */
async function tokenFor(
  env: Bindings,
  connection: ConnectionRow,
  provider: NonNullable<ReturnType<typeof providerFor>>,
): Promise<TokenEnvelope> {
  const admin = serviceClient(env);
  const full = await withSecret(env, connection);

  const stored = JSON.parse(
    await decryptSecret(full.secret_ciphertext, env.ROUTINE_SECRET_KEY),
  ) as TokenEnvelope;
  const fresh = await provider.refresh(env, stored, fetch.bind(globalThis));

  if (fresh.accessToken !== stored.accessToken) {
    await admin
      .from("connections")
      .update({
        secret_ciphertext: await encryptSecret(JSON.stringify(fresh), env.ROUTINE_SECRET_KEY),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
  }
  return fresh;
}

export { connections, connectionsPublic };
