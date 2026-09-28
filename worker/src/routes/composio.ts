import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId, memberRole } from "../lib/workspace";
import { mapToolConnection, mapToolConnectionGrant } from "../lib/dto";
import { insertErrorStatus } from "../lib/routines/insert-error";
import {
  allowedLogoUrl,
  composioConfigured,
  createLink,
  getConnectedAccount,
  getToolkit,
  listToolkits,
  listToolkitCategories,
  listToolkitTools,
  COMPOSIO_BASE,
  type ComposioToolkit,
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
 * before it — and one 0063 sharpens: the row carries `connected_account_id`,
 * which no client role may select, so a client that could insert could write
 * another workspace's account id and never read back what it wrote to check.
 * Grants are ordinary writes through the caller's client, where the policies in
 * 0063 decide who may promote one to `always`.
 */
const composio = new Hono<AppEnv>();

/**
 * The one route here a browser reaches without a token, and the reason is an
 * HTML element rather than a policy: `<img>` sends no `Authorization` header
 * and never will. `connectionsPublic` and `slackPublic` are outside the
 * authenticated router for the same kind of reason.
 *
 * What stands in for a caller is the allowlist in `allowedLogoUrl`. There is
 * nothing to authorise here — every address it admits is a public logo on a
 * host we named — and nothing to leak: the route reads no database, holds no
 * secret, and sends no API key upstream.
 */
const composioPublic = new Hono<AppEnv>();

/** A toolkit slug as Composio spells it, loosened to what a URL can carry. */
const toolkitPattern = /^[a-z0-9_-]{1,80}$/;

/**
 * How many of an application's operations the detail card is shown.
 *
 * Enough to answer "what can this thing do" and not enough to become the page.
 * Kept small for a second reason worth writing down: catalogue rows can carry
 * their whole argument schema, and `client.ts` caps a response at 256KB — past
 * it the body does not parse and the card silently shows nothing rather than
 * too much.
 */
const TOOLKIT_OPERATIONS = 10;

/** Long enough for a cold CDN, short enough that a grid does not hang on one tile. */
const LOGO_TIMEOUT_MS = 5_000;

/** A logo is a few kilobytes. A megabyte is the ceiling, not the expectation. */
const MAX_LOGO_BYTES = 1024 * 1024;

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
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, toolkit_slug, status, created_by, created_at, updated_at";

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
  // approval (0063).
  return Boolean(role) && role !== "viewer";
}

/**
 * A toolkit as the browser is given it.
 *
 * The one difference from `ComposioToolkit` is the logo, and it is the whole
 * point of the rewrite below: the upstream address never reaches the page, so
 * no amount of client code can accidentally make forty requests to somebody
 * else's CDN. What the page gets is a path on this API, and the only thing
 * that can be behind it is a host `allowedLogoUrl` admits.
 */
type WireToolkit = Omit<ComposioToolkit, "logo"> & { logoPath: string };

function toWire({ logo, ...rest }: ComposioToolkit): WireToolkit {
  return { ...rest, logoPath: logo ? `/composio/logo?u=${encodeURIComponent(logo)}` : "" };
}

composio.get("/composio/toolkits", async (c) => {
  if (!composioConfigured(c.env)) {
    // Not an error state. The page says which variable would turn this on,
    // exactly as `providerAvailability` does for Notion — a self-hoster reading
    // the docs for a feature their own build appears not to have is the failure
    // that pattern exists to avoid.
    return c.json({ configured: false, toolkits: [], nextCursor: "" });
  }
  const listed = await listToolkits(c.env, {
    search: c.req.query("search") ?? undefined,
    category: c.req.query("category") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined,
  });
  if (listed.kind === "error") return c.json({ error: listed.message }, 502);
  // The browser never sees the API key: this route is the proxy that keeps a
  // deployment secret out of a bundle anyone can read.
  return c.json({
    configured: true,
    toolkits: listed.toolkits.map(toWire),
    nextCursor: listed.nextCursor,
  });
});

/**
 * One application, described well enough to decide about before connecting it.
 *
 * WHY IT EXISTS. Until this route, clicking a tile in the catalogue *connected*
 * it — a single click on a name in a grid of fifteen hundred handed the browser
 * to a third party's consent screen, having told the person one truncated line
 * of description. This is what the click opens instead.
 *
 * THE OPERATIONS MAY LEGITIMATELY BE ABSENT, and `null` is how that is said.
 * `null` means the list was not read; `[]` means it was read and there are none.
 * The two are not the same thing to a card and TypeScript makes it handle both.
 * A failure reading them does NOT fail this route: nobody should be stopped from
 * connecting Gmail because a catalogue read wobbled, and Connect does not depend
 * on the list.
 *
 * 404 AND 502 ARE DIFFERENT ANSWERS here, where `POST /composio/connect` flattens
 * both to 502. The card has to tell "we have never heard of this application"
 * from "Composio is down", because only one of the two is worth retrying.
 *
 * NOT METERED, and deliberately. `spend()` is the agent's, not the browser's —
 * `/composio/toolkits` and `/composio/categories` spend nothing for the same
 * reason, and charging a workspace's token allowance to *read about* an
 * application would be a new and surprising rule on the one page whose whole job
 * is browsing. A card open is at most two upstream requests against a grid page
 * that already costs one per forty tiles. `rateLimit("standard")` sits in front
 * of the whole authenticated API, and `meteredFetch` still counts subrequests
 * wherever a meter exists — which on this route is nowhere, because only a chat
 * turn carries one.
 */
composio.get("/composio/toolkits/:slug", async (c) => {
  const slug = (c.req.param("slug") ?? "").trim().toLowerCase();
  // Before the network, and the same regex `connectSchema` uses, so a malformed
  // slug costs nothing at all.
  if (!toolkitPattern.test(slug)) return c.json({ error: "not an application slug" }, 400);

  if (!composioConfigured(c.env)) {
    return c.json({ configured: false, toolkit: null, operations: null, total: null, more: false });
  }

  // In parallel: they are independent reads and each carries its own 15s
  // timeout, so sequential would make a cold card cost up to thirty seconds.
  const [described, listed] = await Promise.all([
    getToolkit(c.env, slug),
    listToolkitTools(c.env, { toolkit: slug, limit: TOOLKIT_OPERATIONS }),
  ]);

  if (described.kind === "error") {
    return described.status === 404
      ? c.json({ error: "no application by that name" }, 404)
      : c.json({ error: described.message }, 502);
  }

  return c.json({
    configured: true,
    toolkit: toWire(described.toolkit),
    operations:
      listed.kind === "ok"
        ? listed.tools.map((t) => ({
            slug: t.slug,
            name: t.name,
            description: t.description,
            destructive: t.destructive,
          }))
        : null,
    total: listed.kind === "ok" ? listed.total : null,
    more: listed.kind === "ok" ? listed.more : false,
  });
});

/**
 * The catalogue's headings, for the filter above the grid.
 *
 * Unconfigured answers the same shape as `/composio/toolkits` rather than an
 * error, for the same reason: a page that has to tell a self-hoster which
 * variable to set cannot do it from a 501.
 */
composio.get("/composio/categories", async (c) => {
  if (!composioConfigured(c.env)) return c.json({ configured: false, categories: [] });
  const listed = await listToolkitCategories(c.env);
  if (listed.kind === "error") return c.json({ error: listed.message }, 502);
  return c.json({ configured: true, categories: listed.categories });
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

  // Read before anything is created, and the browser's word is not taken for
  // either answer. Whether this application needs a sign-in decides which
  // kind of auth config gets made; where its mark lives is written onto the
  // row below so the card keeps its logo without searching a catalogue of
  // fifteen hundred for a slug it already has.
  const described = await getToolkit(c.env, toolkit);
  if (described.kind === "error") return c.json({ error: described.message }, 502);

  // The identity Composio executes on behalf of, chosen here and stored on the
  // row. Deliberately not `userId`: a Covan account uuid shipped to a third
  // party as a durable identifier is a thing this codebase does not do, and it
  // would be the wrong value anyway — the same connection is used by a chat
  // turn and by a 3am routine, which resolve to different people.
  const composioUserId = crypto.randomUUID();

  const link = await createLink(c.env, {
    toolkit,
    userId: composioUserId,
    noAuth: described.toolkit.noAuth,
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
      // No per-row address on this transport, and the column is NOT NULL. 0063's
      // banner argues the duplication rather than widening the check.
      base_url: (c.env.COMPOSIO_BASE_URL || COMPOSIO_BASE).replace(/\/+$/, ""),
      auth_kind: "composio",
      // Meaningless here, as it is for `sql` and `supabase`: the method is
      // Composio's business. Said explicitly so the row reads sensibly.
      allowed_methods: ["GET"],
      // The mark, as the catalogue published it and already through
      // `allowedLogoUrl` on the way in. Written here rather than looked up
      // later because a connected application is one row out of fifteen
      // hundred, and finding it again would mean searching for it.
      config: described.toolkit.logo ? { logo: described.toolkit.logo } : {},
      secret_ciphertext: null,
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

  // The account id is readable by no client role (0063), so this is the service
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
 * the whole access control: 0063's policies admit a member to read, a writer to
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
  // (0063), so a value that does not match the agent's or the connection's is
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
  // standing permission away can never be the unsafe direction (0063).
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

/**
 * One application's mark, fetched by us so the page does not fetch it itself.
 *
 * WHY THIS EXISTS AT ALL, since `meta.logo` is a perfectly good public URL and
 * an `<img>` could point straight at it. Two reasons, and the first is the
 * one that decided it: a catalogue grid pointed at Composio's CDN tells
 * Composio the address of every person who opens the Integrations page, on
 * every open, forty times. That is a third party learning something about our
 * users that the feature does not need them to learn. The second is that
 * Composio's own logo hosting is unreliable in a documented way — a set of
 * toolkits 404, and at least one has served the wrong company's mark — so
 * there has to be a place that turns a bad answer into no answer, and a place
 * that can do it is a place we control.
 *
 * WHAT KEEPS IT FROM BEING AN OPEN PROXY: `allowedLogoUrl`, and only that. It
 * takes the address from the query string — which is to say from anybody —
 * and admits it only if it is HTTPS on one of two named hosts. Everything
 * else about the request is refused before a socket is opened.
 *
 * WHY IT IS NOT RATE LIMITED with the rest of the API: it is mounted in
 * `index.ts` ahead of `rateLimit("standard")` on purpose. That tier is keyed
 * by address and exists to protect the Supabase token check standing behind
 * it; this route never reaches that check. Counting forty logos against it
 * would let a first page load spend a third of the budget that a person's
 * actual requests need, and the visible failure would be a 429 on a chat
 * message. What bounds this instead is the allowlist, a one-megabyte ceiling
 * and a short timeout.
 */
composioPublic.get("/composio/logo", async (c) => {
  const url = allowedLogoUrl(c.req.query("u") ?? "");
  if (!url) return c.body(null, 400);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      // A redirect is an invitation to fetch an address nobody allowlisted,
      // which is exactly the check above being asked to hold twice. Refused
      // for the reason every other outbound call in this codebase refuses it.
      redirect: "manual",
      signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
      headers: { Accept: "image/*", "User-Agent": "covan/1.0" },
    });
  } catch {
    return c.body(null, 404);
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return c.body(null, 404);

  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_LOGO_BYTES) return c.body(null, 404);
  const bytes = await res.arrayBuffer().catch(() => null);
  if (!bytes || bytes.byteLength > MAX_LOGO_BYTES) return c.body(null, 404);

  return c.body(bytes, 200, {
    "Content-Type": type,
    // A week, and immutable: a logo that changes is a logo with a different
    // URL as far as anybody here is concerned, and the alternative is paying
    // for the whole grid again on every visit.
    "Cache-Control": "public, max-age=604800, immutable",
    "X-Content-Type-Options": "nosniff",
    // An SVG opened directly in a tab is a document, and a document from a
    // third party is a document that can carry script. Inside an `<img>` it
    // cannot run; typed into the address bar it could, and it would run on
    // this API's origin. Neither costs us anything to prevent.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
});

export { composio, composioPublic };
