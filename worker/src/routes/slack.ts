import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../types";
import { serviceClient } from "../lib/supabase";
import { getActiveWorkspaceId } from "../lib/workspace";
import { deferred } from "../lib/defer";
import { encryptSecret } from "../lib/secret-box";
import { readState, signState } from "../lib/connections/oauth-state";
import { entitlementsFor } from "../lib/entitlements";
import { verifySlackSignature } from "../lib/slack/verify";
import { exchangeSlackCode } from "../lib/slack/api";
import { handleSlackEvent, type InstallationRow, type SlackEvent } from "../lib/slack/handle";

/**
 * Slack: installing the app, and receiving what it hears.
 *
 * Two of these routes are public and they are public for different reasons. The
 * install callback carries a browser back from Slack's consent screen with no
 * session — the same problem `connections` has, solved the same way. The events
 * endpoint is called by Slack itself, which has no Covan account at all and
 * never will: what stands in for authentication there is the signature, and
 * `lib/slack/verify.ts` is the whole of that argument.
 */

const slack = new Hono<AppEnv>();

/** Unauthenticated by necessity — mounted on the root app, not on `api`. */
const slackPublic = new Hono<AppEnv>();

/**
 * What the app asks Slack for.
 *
 * `users:read.email` is the one worth defending, because it looks like more
 * than it is: without it the app cannot tell who is asking, and 0041 explains
 * why answering as the installer instead is the end of tenancy. The rest is the
 * minimum to hear a mention, hear a DM, and reply.
 */
const SCOPES = ["app_mentions:read", "chat:write", "im:history", "users:read", "users:read.email"];

function slackConfigured(env: Bindings): boolean {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET);
}

function apiOrigin(c: { env: Bindings; req: { url: string } }): string {
  return c.env.WORKER_HOST
    ? `https://${c.env.WORKER_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
    : new URL(c.req.url).origin;
}

function frontendOrigin(env: Bindings): string {
  return env.ALLOWED_ORIGIN.split(",")[0].trim().replace(/\/+$/, "");
}

const INSTALLATION_SELECT =
  "id,workspace_id,team_id,team_name,bot_user_id,agent_id,installed_by,created_at";

/**
 * Every route below scopes to the caller's *active* workspace, and none of them
 * could get away with letting RLS do it alone.
 *
 * A person can be an admin of two workspaces, and 0041's policies are written
 * from the workspace's point of view — so an unscoped read returns both
 * installations, an unscoped update changes both, and an unscoped delete
 * disconnects a Slack the caller was not looking at. The policy is still the
 * thing that says *whether* they may; this says *which*.
 */
async function activeInstallationId(c: Context<AppEnv>): Promise<string | null> {
  const db = c.get("db");
  const workspaceId = await getActiveWorkspaceId(db, c.get("user").id);
  if (!workspaceId) return null;

  const { data } = await db
    .from("slack_installations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

// GET /slack — whether Slack is available here, and what is installed.
slack.get("/slack", async (c) => {
  const db = c.get("db");
  const workspaceId = await getActiveWorkspaceId(db, c.get("user").id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const { data, error } = await db
    .from("slack_installations")
    .select(INSTALLATION_SELECT)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load the Slack installation" }, 500);

  return c.json({
    configured: slackConfigured(c.env),
    installation: data
      ? {
          id: data.id,
          teamName: data.team_name,
          agentId: data.agent_id,
          installedBy: data.installed_by,
          createdAt: Date.parse(data.created_at as string),
        }
      : null,
  });
});

// POST /slack/install/start — begin the install.
slack.post("/slack/install/start", async (c) => {
  if (!slackConfigured(c.env)) {
    return c.json({ error: "Slack is not configured on this deployment" }, 501);
  }

  const user = c.get("user");
  const workspaceId = await getActiveWorkspaceId(c.get("db"), user.id);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const state = await signState(
    { provider: "slack", userId: user.id, workspaceId },
    c.env.ROUTINE_SECRET_KEY,
  );

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", c.env.SLACK_CLIENT_ID ?? "");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("redirect_uri", `${apiOrigin(c)}/slack/callback`);
  url.searchParams.set("state", state);

  return c.json({ url: url.toString() });
});

const patchSchema = z.object({ agentId: z.string().min(1) });

// PATCH /slack/installation — choose which agent answers.
slack.patch("/slack/installation", async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const id = await activeInstallationId(c);
  if (!id) return c.json({ error: "not found" }, 404);

  // Through the caller's own client: the policy decides whether they are the
  // installer or an admin, and its WITH CHECK is what stops the agent being
  // pointed at another workspace's. `agent_id` is the only column 0041 grants —
  // `updated_at` is not one, and setting it here would fail the whole statement
  // with a permission error rather than a refusal anybody could read.
  const { data, error } = await c
    .get("db")
    .from("slack_installations")
    .update({ agent_id: parsed.data.agentId })
    .eq("id", id)
    .select("id,agent_id")
    .maybeSingle();
  if (error) return c.json({ error: "failed to update the Slack installation" }, 500);
  if (!data) return c.json({ error: "you do not have permission to change this" }, 403);

  return c.json({ id: data.id, agentId: data.agent_id });
});

// DELETE /slack/installation — disconnect.
//
// Only the row goes. Slack's own side of an install is revoked from Slack, and
// pretending otherwise — by calling `auth.revoke` here — would leave the two
// disagreeing whenever that call failed. The conversations stay: they are
// ordinary sessions, and 0041 lets `slack_threads` cascade rather than taking
// them with it.
slack.delete("/slack/installation", async (c) => {
  const id = await activeInstallationId(c);
  if (!id) return c.json({ error: "not found" }, 404);

  const { data, error } = await c
    .get("db")
    .from("slack_installations")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return c.json({ error: "failed to disconnect Slack" }, 500);
  if (!data || data.length === 0) {
    return c.json({ error: "you do not have permission to disconnect this" }, 403);
  }
  return c.json({ ok: true });
});

// GET /slack/callback — the other end of the install.
slackPublic.get("/slack/callback", async (c) => {
  const home = `${frontendOrigin(c.env)}/integrations`;
  const fail = (reason: string) => c.redirect(`${home}?error=${encodeURIComponent(reason)}`, 302);

  const url = new URL(c.req.url);
  if (url.searchParams.get("error")) return fail("cancelled");
  if (!slackConfigured(c.env)) return fail("unavailable");

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState) return fail("missing_code");

  const state = await readState(rawState, c.env.ROUTINE_SECRET_KEY);
  if (!state || state.provider !== "slack") return fail("expired");

  // Service role for the same two reasons as the connections callback: the row
  // holds a bot token that has to be encrypted before the database sees it, and
  // there is no caller here for RLS to resolve. Both checks below are what
  // stands in for it.
  const admin = serviceClient(c.env);

  const { data: membership } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.userId)
    .maybeSingle();
  if (!membership) return fail("not_a_member");
  // Installing an app that answers on the workspace's behalf is an
  // administrative act, not an authoring one.
  if (membership.role !== "admin") return fail("admin_only");

  let install;
  try {
    install = await exchangeSlackCode(
      fetch.bind(globalThis),
      c.env,
      code,
      `${apiOrigin(c)}/slack/callback`,
    );
  } catch (err) {
    console.error("slack install failed", err);
    return fail("exchange_failed");
  }

  // Which agent answers, before anybody has been asked. The oldest one is the
  // workspace's first and usually its main; the alternative is an app that is
  // installed and refuses every question until somebody visits a settings page
  // they have not been told about.
  const { data: agent } = await admin
    .from("agents")
    .select("id")
    .eq("workspace_id", state.workspaceId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { error } = await admin.from("slack_installations").upsert(
    {
      workspace_id: state.workspaceId,
      team_id: install.teamId,
      team_name: install.teamName,
      bot_user_id: install.botUserId,
      secret_ciphertext: await encryptSecret(install.botToken, c.env.ROUTINE_SECRET_KEY),
      agent_id: agent?.id ?? null,
      installed_by: state.userId,
      updated_at: new Date().toISOString(),
    },
    // Re-installing is the ordinary way to fix a revoked token or add a scope,
    // and Slack issues a new bot token each time. Conflicting on the team keeps
    // one row per Slack workspace and refreshes the credential in place, so the
    // threads already linked to this installation keep working.
    { onConflict: "team_id" },
  );
  if (error) {
    console.error("failed to save the slack installation", error);
    return fail("save_failed");
  }

  return c.redirect(`${home}?connected=slack`, 302);
});

/**
 * POST /slack/events — everything the app hears.
 *
 * Slack gives an app three seconds to acknowledge and retries when it does not,
 * so this route answers 200 first and does the work in `deferred`. That is not
 * an optimisation: a reply takes a model call, and every one of those would be
 * a retry — and a retry that arrives while the first is still running is a
 * second answer in the thread.
 */
slackPublic.post("/slack/events", async (c) => {
  // The raw body, byte for byte. Re-serialising the parsed JSON produces a
  // different string and the signature is over what Slack sent.
  const body = await c.req.text();

  const verified = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET ?? "",
    {
      signature: c.req.header("x-slack-signature"),
      timestamp: c.req.header("x-slack-request-timestamp"),
    },
    body,
  );
  if (!verified.ok) {
    console.warn("slack event rejected:", verified.reason);
    return c.json({ error: "unauthorized" }, 401);
  }

  const payload = JSON.parse(body) as {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: SlackEvent;
  };

  // The handshake Slack does when the URL is first entered. It arrives signed,
  // so it is checked above like anything else.
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback" || !payload.event || !payload.team_id) {
    return c.json({ ok: true });
  }

  // A retry means our acknowledgement did not arrive, not that the work did not
  // happen — the 200 below is sent before any of it starts. Answering again
  // would post a second reply into a thread that may already have one, so the
  // retry is dropped and said out loud. If these ever appear in the logs in
  // numbers, the acknowledgement is too slow rather than the retry wrong.
  const retry = c.req.header("x-slack-retry-num");
  if (retry) {
    console.warn("slack retry dropped", { retry, reason: c.req.header("x-slack-retry-reason") });
    return c.json({ ok: true });
  }

  const event = payload.event;
  const teamId = payload.team_id;

  deferred(
    c,
    (async () => {
      const admin = serviceClient(c.env);
      const { data: installation, error } = await admin
        .from("slack_installations")
        .select("id,workspace_id,team_id,bot_user_id,secret_ciphertext,agent_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (error || !installation) {
        // A Slack workspace we have no row for. Silent on purpose: it is either
        // an install that was removed here and not there, or somebody pointing
        // their own Slack app at this URL, and neither deserves a message
        // posted into a stranger's channel.
        console.warn("slack event for an unknown team", teamId);
        return;
      }

      await handleSlackEvent(installation as InstallationRow, event, {
        db: admin,
        env: c.env,
        entitlements: entitlementsFor(c.env),
        fetchImpl: fetch.bind(globalThis),
      });
    })(),
  );

  return c.json({ ok: true });
});

export { slack, slackPublic };
